# Підключення Supabase

## Уже підготовлено в коді

- Міграція створює спільні таблиці для каталогу, закупівель, документів та результатів аналізу PDF.
- Увімкнено Row Level Security: читання й зміни доступні лише користувачам, які увійшли через Supabase Auth.
- Створюється приватний Storage bucket `procurement-files` для майбутніх завантажених файлів.
- Google-вхід не використовується. Запланований спосіб входу — email magic link.

## Одноразові дії власника проєкту

1. Створіть новий проєкт у Supabase.
2. У SQL Editor виконайте файл `supabase/migrations/20261012_initial_shared_workspace.sql`.
3. У **Authentication → Providers → Email** увімкніть email magic link.
4. У **Authentication → URL Configuration** додайте production-адресу застосунку до Redirect URLs.
5. У Vercel додайте змінні середовища `SUPABASE_URL` та `SUPABASE_ANON_KEY` для Production і Preview.

Не додавайте service-role key у Vercel frontend або GitHub. Він не потрібен для поточної архітектури.
