# Brand extraction verification

## Start scrape
```bash
curl -X POST "$API_BASE/api/scrape/start" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

## Check bot config fields
```bash
curl "$API_BASE/api/business/bot-config" \
  -H "Authorization: Bearer $JWT"
```
Expected keys under `brand`: `business_name`, `logo_url`, `favicon_url`, `primary_color`, `secondary_color`, `fonts`, `welcome_message`, `starter_prompts`, `status`.

## Approve/edit draft from Bubble
```bash
curl -X PATCH "$API_BASE/api/business/bot-config/draft" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "businessName":"Acme Dental",
    "logoUrl":"https://example.com/logo.png",
    "primaryColor":"#0055AA",
    "secondaryColor":"#00AACC",
    "fonts":["Inter","Roboto"],
    "welcomeMessage":"Welcome to Acme Dental! How can we help today?",
    "starterPrompts":["Book a cleaning","Do you accept insurance?","What are your hours?"],
    "approve":true
  }'
```

## Preview endpoint
```bash
curl "$API_BASE/api/business/bot-config/$BOT_ID/preview"
```

## Force refresh overwrite
```bash
curl -X POST "$API_BASE/api/scrape/refresh" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```
`/refresh` jobs run with `is_refresh=true` and can replace approved brand fields.
