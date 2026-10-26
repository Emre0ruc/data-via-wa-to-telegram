// One-shot helper: lists the chats that recently wrote to the bot, so you can find
// your TELEGRAM_CHAT_ID. Read-only: replies to nobody and does not mark updates as read.
import { Api, GrammyError } from 'grammy';
import type { Chat } from 'grammy/types';
import { ConfigError, loadBotToken } from '../config.js';

function describe(chat: Chat): string {
  if (chat.type === 'private') {
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
    return `private  ${name}${chat.username ? ` (@${chat.username})` : ''}`;
  }
  return `${chat.type.padEnd(8)} ${chat.title}`;
}

async function main(): Promise<void> {
  const api = new Api(loadBotToken());
  const me = await api.getMe();

  // No offset: Telegram keeps these updates (for 24h) and we leave them unconfirmed.
  const updates = await api.getUpdates({ limit: 100, timeout: 0 });

  const chats = new Map<number, Chat>();
  for (const u of updates) {
    const chat = (u.message ?? u.edited_message ?? u.my_chat_member)?.chat;
    if (chat) chats.set(chat.id, chat);
  }

  if (chats.size === 0) {
    console.log(`No chats found. Open @${me.username} in Telegram, send /start, then run this again.`);
    return;
  }

  console.log(`Chats that wrote to @${me.username} in the last 24h:\n`);
  for (const chat of chats.values()) {
    console.log(`  ${String(chat.id).padEnd(16)} ${describe(chat)}`);
  }
  console.log('\nPut YOUR id into .env as TELEGRAM_CHAT_ID. Anyone can find and message a bot,');
  console.log('so check the name: every relayed message will go to this chat.');
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else if (err instanceof GrammyError && err.error_code === 401) {
    console.error('Telegram rejected the token (401 Unauthorized). Check TELEGRAM_BOT_TOKEN.');
  } else if (err instanceof GrammyError && err.error_code === 409) {
    console.error('Conflict (409): a webhook is set or another process is polling this bot.');
  } else {
    console.error(err);
  }
  process.exit(1);
});
