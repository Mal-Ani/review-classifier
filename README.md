





https://github.com/user-attachments/assets/dc668e61-ee33-4efd-af7d-24118e56bad3

Скрипт читает отзывы покупателей из CSV-файла, отправляет каждый отзыв в LLM
через API [OpenRouter](https://openrouter.ai), получает структурированный
JSON-ответ (тональность + тема) и сохраняет итог в `output/result.json`.

## Задача

Для каждого отзыва о товаре модель определяет:

- `sentiment` — тональность: `positive` / `negative` / `neutral`
- `topic` — краткая тема отзыва (например: «качество сборки», «проблема с доставкой»)


## Запуск

Node.js 22.6.0 и выше
LLM: openai/gpt-4o-mini https://openrouter.ai/openrouter/free

API-ключ: Создать ключ на https://openrouter.ai/settings/keys

1. создать файл .env:
2. впиcать свой ключ в .env (OPENROUTER_API_KEY=sk-or-v1-....)
3. npm start (Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process)

## Формат входных данных

CSV-файл с колонками:

```csv
id,author,product,review_text
1,Анна К.,Беспроводные наушники SoundX Pro,"Купила месяц назад, звук просто отличный..."
2,Дмитрий В.,Робот-пылесос CleanBot 3000,"Собирает мусор неплохо, но постоянно застревает..."
```

Пример полного файла — `data/reviews.csv` 

## Формат выходных данных

Результат сохраняется в `output/result.json` в виде объекта с метаданными
запуска и массивом результатов по каждому отзыву:

```json
{
  "generated_at": "2026-06-21T10:15:32.000Z",
  "model": "openai/gpt-4o-mini",
  "input_file": "data/reviews.csv",
  "total_reviews": 18,
  "succeeded": 18,
  "failed": 0,
  "results": [
    {
      "id": "1",
      "author": "Анна К.",
      "product": "Беспроводные наушники SoundX Pro",
      "review_text": "Купила месяц назад, звук просто отличный...",
      "sentiment": "positive",
      "topic": "качество звука"
    },
    {
      "id": "4",
      "author": "Сергей П.",
      "product": "Смарт-часы FitTrack 5",
      "review_text": "Ужасное качество! Через две недели использования...",
      "sentiment": "negative",
      "topic": "брак и поддержка"
    }
  ],
  "errors": []
}
```
Если для какого-то отзыва после нескольких попыток не удалось получить валидный ответ от модели, он попадёт в массив `errors` с указанием `id` и причины. Весь процесс не прерывается всё, что удалось обработать успешно, сохраняется.


