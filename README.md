# Vinted Telegram Bot

Telegram bot for Vinted based on https://github.com/teddy-vltn/vinted-discord-bot

Watches Vinted catalog searches and sends a Telegram message the moment a new item shows up.

This is a Telegram port of [teddy-vltn/vinted-discord-bot](https://github.com/teddy-vltn/vinted-discord-bot).
The Vinted side — cookie handling, catalog polling, proxy rotation, item parsing, URL filtering — is
kept from the original; everything that talked to Discord was rewritten for Telegram.

---

## What it does

- Watch any number of Vinted catalog searches, each with its own name and its own timer.
- New items arrive as a photo with price, size, brand, condition, seller rating and a link.
- Every search can be paused, resumed, renamed and deleted from an inline keyboard.
- Banned keywords per search, so a word you never want to see filters the results out.
- Multi marketplace: a `vinted.pl` link is watched on `vinted.pl`, a `vinted.fr` link on `vinted.fr`,
  each with its own session cookie.
- Notifications go into the chat the search was created in — your private chat, a group, or a topic
  of a forum group.
- Per user limits, an optional allow list, and admin commands for statistics, limits and broadcasts.
- English and Russian interface, chosen automatically from the Telegram client.

## From Discord to Telegram

| vinted-discord-bot | this bot |
| --- | --- |
| a private channel or thread per search | a **subscription**: a named search delivered into a chat |
| `/create_private_channel`, `/start_monitoring` | `/add` (one dialog: URL → name → banned words) |
| `/stop_monitoring`, `/delete_private_channel` | buttons under `/list` |
| embeds with fields | HTML captions under the item photo |
| action rows | inline keyboards |
| `@user` mentions on a hit | loud or silent notifications (`/settings`) |
| admin role id in the guild | `TELEGRAM_ADMIN_IDS` |
| channel inactivity cleanup with a message collector | the same feature, driven by the database |

## Requirements

- Node.js 20 or newer, or Docker with Docker Compose
- MongoDB (the Compose file brings one)
- A bot token from [@BotFather](https://t.me/BotFather)
- Proxies are optional; without them everything runs from your own IP

## Setup

1. Create the bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Copy the configuration and fill it in:

   ```bash
   cp .env.example .env
   ```

   At minimum set `TELEGRAM_BOT_TOKEN`. Put your own numeric Telegram id (ask
   [@userinfobot](https://t.me/userinfobot)) into `TELEGRAM_ADMIN_IDS` to unlock the admin commands.

3. Start it.

   **With Docker** — this also starts MongoDB:

   ```bash
   ./start.sh
   ```

   Stop it again with `./stop.sh`.

   **Without Docker** — a MongoDB has to be reachable, and `MONGODB_URI` has to point at it
   (for a local server usually `mongodb://127.0.0.1:27017/vinted`):

   ```bash
   npm install
   npm start
   ```

4. Open the chat with your bot and send `/start`.

## Using it

Send `/add` and paste the address of a Vinted results page. The URL has to be a `/catalog` page and
carry at least one filter:

```
https://www.vinted.fr/catalog?brand_ids[]=53&price_to=50&status_ids[]=6
```

Set the filters on the Vinted website, then copy the address bar — that is the whole trick.

| command | what it does |
| --- | --- |
| `/start` | register and see the short introduction |
| `/add` | watch a new search (`/add <url>` skips the first question) |
| `/list` | all your searches, with pause / resume / delete buttons |
| `/settings` | silent notifications, interface language |
| `/info` | your limits and what the bot is doing for you |
| `/delete_all` | remove every search you have |
| `/cancel` | abort the current dialog |
| `/help` | the list above, inside Telegram |

Admins additionally get `/admin_stats`, `/admin_setmax <telegram id> <limit>` and
`/admin_broadcast <text>` (with a confirmation step before anything is sent).

To deliver into a group, add the bot to the group and run `/add` there. In a forum group the
notifications stay in the topic the command was sent from.

## Configuration

Everything lives in `.env`; `.env.local` overrides it and is not committed.

| key | meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | token from @BotFather |
| `TELEGRAM_ADMIN_IDS` | comma separated user ids that may use the admin commands |
| `TELEGRAM_ALLOWED_USER_IDS` | when set, only these ids may use the bot at all |
| `ITEM_PHOTOS` | `1` sends one photo with buttons, `2`–`10` send an album (Telegram allows no buttons under an album, so the links move into the caption) |
| `VINTED_API_DOMAIN_EXTENSION` | default marketplace, used when a URL does not say otherwise |
| `MONITOR_INTERVAL_SECONDS` | how often one search is checked |
| `ALGORITHM_CONCURRENT_REQUESTS` | parallel item detail requests |
| `ALGORITHM_FILTER_ZERO_STARS_PROFILES` | skip sellers without a rating |
| `USER_MAX_SUBSCRIPTIONS_DEFAULT` | searches a new user may run |
| `ALLOW_USER_TO_CREATE_SUBSCRIPTIONS` | `0` limits creating searches to admins |
| `ENABLE_SUBSCRIPTION_INACTIVITY` | ask about searches that find nothing for days |
| `USE_WEBSHARE`, `WEBSHARE_API_KEY` | pull the proxy list from Webshare.io |
| `MONGODB_URI` | database connection string |
| `DEV_MODE`, `DUMP_LOGS` | verbose logging, and writing it to `app.log` |

### Proxies

Without proxies the bot works, but all requests come from one IP and Vinted starts answering with
429 the more searches you run. Two ways to add them:

- `USE_WEBSHARE=1` plus `WEBSHARE_API_KEY` pulls the list from Webshare.io.
- `USE_WEBSHARE=0` reads `proxies.txt` from the project root, one SOCKS proxy per line as
  `ip:port:username:password`.

A proxy that fails a request is parked for a minute and then tried again.

## How it works

```
main.js
 ├── CookieService          one Vinted session cookie per marketplace, refreshed every minute
 ├── SubscriptionMonitor    one timer per search: poll the catalog, keep the last seen item id
 │     ├── fetchCatalogItems     server side filtering from the search URL
 │     ├── fetchItemDetail       description and seller rating from the item page
 │     └── url_service           banned keywords and fuzzy text match on top
 ├── TelegramService        one send queue for the whole bot: rate limits, retries, blocked chats
 └── bot/client.js          commands, inline keyboards, dialogs
```

- **One timer per search.** A failing search does not stop the others, and a 429 only slows down
  the search that caused it, doubling its interval until it succeeds again.
- **The last seen item id is stored in the database.** A restart neither resends what you already
  saw nor silently drops what appeared while the bot was down.
- **Everything outgoing goes through one queue.** Telegram allows about 30 messages per second and
  one per second per chat; the queue enforces both and obeys `retry_after` on a 429.
- **A blocked chat stops itself.** When Telegram reports that the bot was blocked or kicked, the
  searches delivering there are paused instead of failing forever.

## Project layout

```
main.js                       wiring and the item notification
locales/                      en.json, ru.json - drop in another file to add a language
src/api/                      Vinted endpoints
src/bot/client.js             bot setup, middleware, command loading
src/bot/commands/             one file per command
src/bot/components/           message and keyboard rendering
src/bot/callbacks.js          inline button router
src/bot/wizard.js             multi step dialogs
src/services/                 cookie, monitor, telegram delivery, inactivity, URL parsing
src/entities/vinted_item.js   the item model
src/crud.js, src/database.js  MongoDB access
src/utils/                    config, logging, proxies, request builder
```

### Adding a language

Copy `locales/en.json` to `locales/<code>.json` and translate the values. It is picked up on the
next start; missing keys fall back to English. The code matches the language of the Telegram client
(`ru`, `ru-RU` and `ru-BY` all find `ru.json`), and `/settings` lets a user override it.

## Troubleshooting

**The bot answers nothing.** Check `TELEGRAM_BOT_TOKEN`, and make sure only one instance is running —
Telegram gives long polling to one client at a time.

**No items ever arrive.** The first check of a new search only records the current state, so nothing
is sent until something genuinely new appears. Verify the search still returns items on the website.

**`invalid_authentication_token` in the log.** The cookie of that marketplace expired or was fetched
through a dead proxy; it is refetched automatically, and a permanently failing marketplace usually
means the proxies are blocked.

**Telegram rejects the photo.** The item is then sent as text with a link, which is expected for the
occasional oversized image.

## Credits

- Original Discord bot: [teddy-vltn/vinted-discord-bot](https://github.com/teddy-vltn/vinted-discord-bot)
- Telegram framework: [grammY](https://grammy.dev)

Not affiliated with Vinted. Use it for your own searches, at a polite request rate.
