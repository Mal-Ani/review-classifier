import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";



const DEFAULT_MODEL = "openrouter/free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 30_000;



interface ReviewRow {
  id: string;
  author: string;
  product: string;
  review_text: string;
}

type Sentiment = "positive" | "negative" | "neutral";

interface ClassificationResult {
  id: string;
  author: string;
  product: string;
  review_text: string;
  sentiment: Sentiment;
  topic: string;
}

interface PipelineSummary {
  generated_at: string;
  model: string;
  input_file: string;
  total_reviews: number;
  succeeded: number;
  failed: number;
  results: ClassificationResult[];
  errors: { id: string; message: string }[];
}



function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Простой и надёжный построчный CSV-парсер с поддержкой кавычек,
 * экранирования "" внутри полей и запятых/переносов строк внутри кавычек.
 * Не использует внешних зависимостей.
 */
function parseCsv(content: string): ReviewRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  
  const text = content.replace(/\r\n/g, "\n");

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        field = "";
        row = [];
      } else {
        field += char;
      }
    }
  }
  
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length < 2) {
    throw new Error("CSV-файл пуст или содержит только заголовок");
  }

  const header = rows[0].map((h) => h.trim());
  const required = ["id", "author", "product", "review_text"];
  for (const col of required) {
    if (!header.includes(col)) {
      throw new Error(
        `В CSV отсутствует обязательная колонка "${col}". Найдены колонки: ${header.join(", ")}`
      );
    }
  }

  const result: ReviewRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const rawRow = rows[r];
    
    if (rawRow.length === 1 && rawRow[0].trim() === "") continue;

    const obj: Record<string, string> = {};
    header.forEach((col, idx) => {
      obj[col] = (rawRow[idx] ?? "").trim();
    });

    if (!obj.id || !obj.review_text) {
      console.warn(
        `⚠️  Пропущена строка ${r + 1}: отсутствует id или review_text`
      );
      continue;
    }

    result.push({
      id: obj.id,
      author: obj.author ?? "",
      product: obj.product ?? "",
      review_text: obj.review_text,
    });
  }

  return result;
}

/**
 * Достаёт JSON-объект из ответа модели, даже если модель обернула его
 * в ```json ... ``` или добавила лишний текст вокруг.
 */
function extractJson(raw: string): unknown {
  let text = raw.trim();

  
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(text);
}

function isValidSentiment(value: unknown): value is Sentiment {
  return value === "positive" || value === "negative" || value === "neutral";
}



function buildPrompt(review: ReviewRow): string {
  return `Проанализируй отзыв покупателя о товаре и верни СТРОГО валидный JSON без какого-либо текста до или после, без markdown-обёртки.

Формат ответа (ровно эти поля, ничего лишнего):
{"sentiment": "positive" | "negative" | "neutral", "topic": "краткая тема в 2-4 словах на русском"}

Правила:
- sentiment отражает общую тональность отзыва.
- topic — это краткая суть отзыва (например: "качество сборки", "проблема с доставкой", "хорошее соотношение цена-качество").
- Если отзыв нейтральный и не содержит явной похвалы или жалобы — sentiment: "neutral".

Товар: ${review.product}
Отзыв: ${review.review_text}`;
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  prompt: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/local/review-classifier",
        "X-Title": "Review Classifier Pipeline",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `OpenRouter API вернул статус ${response.status} ${response.statusText}. ${errorBody}`
      );
    }

    const data = await response.json();

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(
        `Пустой или некорректный ответ от модели: ${JSON.stringify(data).slice(0, 300)}`
      );
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyReview(
  apiKey: string,
  model: string,
  review: ReviewRow
): Promise<ClassificationResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const prompt = buildPrompt(review);
      const rawContent = await callOpenRouter(apiKey, model, prompt);

      let parsed: unknown;
      try {
        parsed = extractJson(rawContent);
      } catch (parseErr) {
        throw new Error(
          `Не удалось распарсить JSON из ответа модели (попытка ${attempt}): ${rawContent.slice(0, 200)}`
        );
      }

      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Ответ модели не является JSON-объектом");
      }

      const obj = parsed as Record<string, unknown>;

      if (!isValidSentiment(obj.sentiment)) {
        throw new Error(
          `Поле "sentiment" имеет недопустимое значение: ${JSON.stringify(obj.sentiment)}`
        );
      }
      if (typeof obj.topic !== "string" || obj.topic.trim() === "") {
        throw new Error('Поле "topic" отсутствует или пустое');
      }

      return {
        id: review.id,
        author: review.author,
        product: review.product,
        review_text: review.review_text,
        sentiment: obj.sentiment,
        topic: obj.topic.trim(),
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `  ⚠️  Отзыв #${review.id}: попытка ${attempt}/${MAX_RETRIES} не удалась — ${lastError.message}`
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError ?? new Error("Неизвестная ошибка классификации");
}



async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", short: "i", default: "data/reviews.csv" },
      output: { type: "string", short: "o", default: "output/result.json" },
      model: { type: "string", short: "m", default: DEFAULT_MODEL },
    },
  });

  const inputPath = values.input!;
  const outputPath = values.output!;
  const model = values.model!;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "❌ Не задана переменная окружения OPENROUTER_API_KEY.\n" +
        "   Запуск: OPENROUTER_API_KEY=sk-or-... node --experimental-strip-types src/classify.ts"
    );
    process.exit(1);
  }

  if (!existsSync(inputPath)) {
    console.error(`❌ Входной файл не найден: ${inputPath}`);
    process.exit(1);
  }

  console.log(`📂 Читаю отзывы из ${inputPath} ...`);
  let reviews: ReviewRow[];
  try {
    const csvContent = readFileSync(inputPath, "utf-8");
    reviews = parseCsv(csvContent);
  } catch (err) {
    console.error(
      `❌ Ошибка чтения/парсинга CSV: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  if (reviews.length === 0) {
    console.error("❌ В CSV не найдено ни одной корректной строки с отзывом.");
    process.exit(1);
  }

  console.log(`✅ Загружено отзывов: ${reviews.length}`);
  console.log(`🤖 Модель: ${model}`);
  console.log(`🚀 Начинаю классификацию...\n`);

  const results: ClassificationResult[] = [];
  const errors: { id: string; message: string }[] = [];

  for (const review of reviews) {
    process.stdout.write(`  Обрабатываю отзыв #${review.id} (${review.product})... `);
    try {
      const result = await classifyReview(apiKey, model, review);
      results.push(result);
      console.log(`✅ ${result.sentiment} / ${result.topic}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`❌ ОШИБКА`);
      errors.push({ id: review.id, message });
    }
  }

  const summary: PipelineSummary = {
    generated_at: new Date().toISOString(),
    model,
    input_file: inputPath,
    total_reviews: reviews.length,
    succeeded: results.length,
    failed: errors.length,
    results,
    errors,
  };

  mkdirSync(outputPath.split("/").slice(0, -1).join("/") || ".", {
    recursive: true,
  });
  writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf-8");

  console.log(`\n📊 Готово: ${results.length} успешно, ${errors.length} с ошибкой.`);
  console.log(`💾 Результат сохранён в ${outputPath}`);

  if (errors.length > 0) {
    console.log(`\n⚠️  Список ошибок:`);
    for (const e of errors) {
      console.log(`   - #${e.id}: ${e.message}`);
    }
    
    
    if (results.length === 0) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("❌ Непредвиденная ошибка пайплайна:", err);
  process.exit(1);
});
