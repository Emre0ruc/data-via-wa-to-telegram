# data-via-wa-to-telegram

Forwards the messages you send to yourself on WhatsApp ("Message yourself") to a Telegram bot.

I couldn't get WhatsApp running on my tablet, but Telegram works fine there. So this small app sits on a computer as a linked WhatsApp device, picks up whatever I drop into my self-chat (notes, links, photos, files) and passes it on to Telegram.

## What it does

- Relays texts, photos and documents from your WhatsApp self-chat to one Telegram chat.
- Ignores every other chat. Messages from other people or groups are dropped without being stored or logged.
- Read-only on the WhatsApp side: it never sends messages or read receipts and doesn't show you as online.
- Skips messages starting with `#gizli` (configurable). Use it for anything you don't want on Telegram.
- Retries when the internet or Telegram is down, with growing delays, and reconnects to WhatsApp the same way.
- Shows the pairing QR code in the Telegram chat, so linking WhatsApp doesn't need the terminal.

Video, voice notes and stickers are not relayed. Messages sent while the app is not running are not picked up later, and messages still waiting for a retry are lost if the app is stopped.

## Setup

You need Node.js 22 or newer and a Telegram account.

1. Create a bot: message [@BotFather](https://t.me/BotFather), send `/newbot` and keep the token it gives you.
2. Install and configure:
   ```sh
   npm ci
   cp .env.example .env    # then put your token into TELEGRAM_BOT_TOKEN
   ```
3. Open your new bot in Telegram and send it `/start`. Then find your chat ID:
   ```sh
   npm run chat-id
   ```
   Put your own ID into `TELEGRAM_CHAT_ID`. Anyone can message a bot, so check the name next to the ID.
4. Start it:
   ```sh
   npm run build
   npm start          # or `npm run dev` while developing
   ```
5. A QR code arrives in the Telegram chat. On your phone, open WhatsApp → Linked devices → Link a device and scan it. The session is saved in `data/session`, so this is a one-time step.

## Configuration

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | | Token from BotFather |
| `TELEGRAM_CHAT_ID` | | The only chat the bot sends to |
| `DATA_DIR` | `./data` | Session and temporary media |
| `LOG_LEVEL` | `info` | `fatal` … `trace`, or `silent` |
| `PRIVATE_PREFIX` | `#gizli` | Messages and captions starting with this are not relayed |

## Good to know

- **Telegram bot chats are not end-to-end encrypted.** Everything relayed is readable by Telegram and stays in its cloud. Keep passwords and similar things out of it, or start them with the private prefix.
- **`data/session` is your WhatsApp login.** Anyone with that folder can read your messages. Don't share it or commit it (it's in `.gitignore`).
- **This uses an unofficial WhatsApp client** ([Baileys](https://github.com/WhiskeySockets/Baileys)). Automating WhatsApp is against its terms of service, and accounts can get banned. The app is read-only and keeps its connection attempts low to stay as close to a normal linked device as possible, but use it at your own risk.
- If you remove the linked device from your phone, the app tells you in Telegram. To link again, stop it, delete `data/session` and start it again.

## Development

```sh
npm test             # unit tests, no network needed
npm run typecheck
```

## License

MIT
