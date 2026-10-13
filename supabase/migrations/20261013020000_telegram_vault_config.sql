-- Telegram bot config read from Vault, so it can be set (and rotated) with SQL instead of pasting dashboard secrets:
--   select vault.create_secret('<token>', 'telegram_bot_token');   -- or vault.update_secret(id, '<new>')
--   select vault.create_secret('<chat id>', 'telegram_chat_id');
--   select vault.create_secret('<secret>', 'telegram_webhook_secret');  -- also used by the pg_cron tick
-- Only the edge function (service role) can call it.
create or replace function public.telegram_config()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'token', (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_bot_token'),
    'chat_id', (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_chat_id'),
    'webhook_secret', (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_webhook_secret')
  );
$$;
revoke all on function public.telegram_config() from public, anon, authenticated;
grant execute on function public.telegram_config() to service_role;
