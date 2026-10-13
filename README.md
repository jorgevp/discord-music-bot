# Discord Music Bot

A self-hosted, containerized Discord music bot with a web dashboard.

- Plays **YouTube, YouTube Music, Spotify, SoundCloud, Bandcamp, Twitch, direct audio files** and anything else [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports. Plain text is searched on YouTube.
- Uses prefix commands in Discord (`!play <link>`, `!skip`, `!queue`, …) and works in any number of servers at once.
- The **web dashboard** shows each server's live queue and lets you control everything: play, pause, skip, previous, seek, volume, loop and shuffle. You can add tracks, search, drag to reorder, remove, jump, choose the voice and announcement channels, and replay from history. All settings live there too, including the bot token, YouTube account, Spotify account and playback behaviour, plus live logs.
- Built for **uninterrupted playback**:
  - You sign the bot in to YouTube with your Google account from the dashboard, and a bundled PO-token provider keeps YouTube from blocking the bot.
  - Each track is read ahead into memory, and the bot resumes at the same position if a stream drops.
  - Voice connections reconnect automatically.
  - yt-dlp updates itself on startup.

## Quick start

You need Docker with Docker Compose.

1. **Create the Discord bot**
   1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
   2. Open **Bot** → **Reset Token**, and copy the token.
   3. On the same page, enable **Message Content Intent** under *Privileged Gateway Intents*. The bot can't read `!play` without it.
   4. Leave **Public Bot** on if people other than you should be able to invite it.
2. **Start it**
   ```bash
   cp .env.example .env        # optional; everything can be set in the dashboard
   docker compose up -d --build
   ```
3. **Open the dashboard** at <http://127.0.0.1:8080>, create a dashboard password, then go to **Settings → Discord**, paste the token and save. The bot comes online within a few seconds.
4. **Invite it** with the **Invite to a server** button. It requests: View Channels, Send Messages, Embed Links, Read Message History, Add Reactions, Connect and Speak.
5. In Discord, join a voice channel and type `!play https://www.youtube.com/watch?v=dQw4w9WgXcQ`.

## Commands

The default prefix is `!` (change it in Settings → Discord).

| Command | Aliases | What it does |
| --- | --- | --- |
| `!play <link or search>` | `!p` | Joins your voice channel and plays or queues a track, playlist, album or search result. Attach an audio file to play it. |
| `!playnext <link or search>` | `!pn`, `!playtop` | Adds to the front of the queue |
| `!skip` | `!s`, `!next` | Skips the current track |
| `!previous` | `!prev`, `!back` | Plays the previous track again |
| `!pause` / `!resume` | `!unpause` | Pauses or resumes |
| `!stop` | | Stops and clears the queue (stays in the channel) |
| `!leave` | `!dc`, `!disconnect` | Leaves the voice channel and clears the queue |
| `!join` | `!summon` | Joins your channel and resumes the queue |
| `!queue [page]` | `!q` | Shows the queue |
| `!nowplaying` | `!np` | Shows the current track with a progress bar |
| `!remove <n>` | `!rm` | Removes track *n* from the queue |
| `!move <from> <to>` | `!mv` | Moves a track within the queue |
| `!jump <n>` | `!skipto`, `!playnow` | Plays track *n* now; the rest of the queue stays |
| `!shuffle` / `!clear` | | Shuffles or empties the upcoming queue |
| `!loop [off\|track\|queue]` | `!repeat` | Sets the loop mode (cycles if no argument is given) |
| `!volume [0-200]` | `!vol`, `!v` | Shows or sets the volume |
| `!seek <1:23>` | | Jumps to a position (also accepts `83` or `1m23s`) |
| `!dashboard` | `!web` | Links to the dashboard (needs **Public URL** set) |
| `!help` | | Lists commands |

**Who can queue:** in **Settings → Playback → Who can queue songs**, pick the roles allowed to use `!play` / `!playnext` in each server. In a server with no roles picked, everyone can queue. Members with *Manage Server* and the DJ role can always queue. Anyone else gets a short "you need the … role" reply, and the bot doesn't join voice or look anything up for them. Tracks added from the dashboard are not restricted.

Control commands follow the **DJ role** setting, which is optional. Members with *Manage Server*, and anyone alone with the bot, can always control playback. By default, people must be in the bot's voice channel to control it.

## YouTube: staying unblocked

YouTube often blocks traffic from servers and data centres ("Sign in to confirm you're not a bot"). The bot has two defences:

1. **PO-token provider.** This is on by default. The `bgutil-provider` container generates the "proof of origin" tokens YouTube expects.
2. **A signed-in Google account.** In **Settings → YouTube**, click **Sign in to YouTube**:
   1. A real Chrome browser (the `youtube-login` container) opens inside the dashboard on Google's sign-in page.
   2. Sign in as usual: email, password and 2-step verification.
   3. When YouTube shows your profile picture in the top-right corner, click **Finish**.
   4. Press **Test YouTube playback** to confirm.

   On Finish, the bot copies the signed-in session (its cookies) out of the browser, then closes and wipes the browser. **Your password goes only to Google and is never stored by the bot.** A window left open is wiped automatically after 30 minutes. To paste text into the sign-in browser (for example from a password manager), open the viewer's side menu → **Clipboard**, paste there, then press Ctrl+V in the browser.

> **Use a secondary Google account.** Automated playback can get an account flagged. The session is stored in the data volume (`/data/youtube-cookies.txt`). It isn't shown in the dashboard or written to the logs. **Sign out** removes it from the bot. Your Google account stays signed in everywhere else.

Why not just enter a username and password in the settings? YouTube no longer lets programs log in that way: yt-dlp answers with "Login with password is not supported for YouTube", and Google's device-code login was shut off as well. Signing in through a real browser is the method that still works.

If YouTube still fails, press **Update yt-dlp now**. New yt-dlp releases fix most breakages. Auto-update on startup is on by default.

### Without the sign-in browser

The `youtube-login` service is optional. To run without it, remove it and the `LOGIN_BROWSER_HOST` line from `docker-compose.yml`, and use **Advanced: paste cookies manually** instead:

1. Open a **private/incognito window** and sign in to youtube.com.
2. In that tab, export youtube.com cookies with a "cookies.txt" extension (Netscape format). Cookie-Editor's JSON export also works.
3. Close the private window **without signing out**.
4. Paste the file contents and save.

## Spotify

Spotify does not let third-party apps stream its audio, and every Discord music bot works around this the same way. The bot reads the track list from the Spotify link and plays each song from its closest YouTube upload. It prefers the same duration, the artist's channel, and official "Topic" uploads, and avoids covers, live versions and remixes unless the Spotify title has them.

Spotify works at three levels:

| Setup | What works |
| --- | --- |
| **Nothing configured** | Public tracks, albums, artists (top 10) and playlists, read from Spotify's public pages. Playlists you don't own are limited to their first **100 tracks**. |
| **App credentials** (client ID + secret) | Tracks and albums through the official API |
| **Connected account** | Also **your own private/collaborative playlists** (full length) and **Liked Songs** (`https://open.spotify.com/collection/tracks`) |

To connect an account:

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and select **Web API**. Since February 2026, development-mode apps require the app owner to have **Spotify Premium** and allow up to 5 users. That's fine for a personal bot.
2. Add the **Redirect URI** shown in Settings → Spotify, exactly as shown. Spotify only accepts `https://…` or `http://127.0.0.1:…` redirect URIs. `localhost` is rejected.
3. Save the client ID and secret, then press **Connect Spotify account**.

**Dashboard on another machine without HTTPS?** Set **Public URL** to `http://127.0.0.1:8080` so the redirect URI is accepted. After you approve on Spotify, the browser lands on a `127.0.0.1` page that won't load. Copy that URL from the address bar and paste it into **"The Spotify redirect page didn't load?"** in Settings.

## Configuration

Everything is configured in the dashboard and stored in the `bot-data` volume (`/data/config.json`). Environment variables in `.env` only **pre-fill empty settings on first start**:

| Variable | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Initial dashboard password (at least 8 characters). Without it, you create one on first visit. |
| `DISCORD_TOKEN`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Pre-fill the matching settings |
| `PUBLIC_URL` | How you reach the dashboard; used for the Spotify redirect and `!dashboard` |
| `WEB_PORT` / `WEB_BIND` | Host port and bind address of the dashboard (defaults `8080` / `0.0.0.0`) |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy that terminates HTTPS |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error` |

The playback settings in the dashboard cover: default volume, queue and playlist limits, auto-leave timers, "Now playing" announcements, DJ role, same-channel requirement, and loudness normalization.

## Security

- The dashboard holds your bot token and the YouTube session, so treat it like an admin panel. It's protected by a password (scrypt-hashed), with login rate-limiting, signed HttpOnly session cookies, CSRF protection and a strict Content-Security-Policy.
- **Don't expose port 8080 to the internet over plain HTTP.** For remote access, use a VPN or put it behind an HTTPS reverse proxy. With nginx, forward the host and WebSocket headers and set `TRUST_PROXY=1`:
  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
  }
  ```
- The sign-in browser has no published ports: the dashboard proxies it behind its own sign-in, and it sits on a private network that only the bot can reach. Chromium runs without its internal sandbox there, because the sandbox needs privileges Docker doesn't grant by default, and the container only ever visits Google's sign-in pages. Over plain HTTP from another machine, the viewer logs a harmless "requires a secure context" console warning.
- To **reset a forgotten password**, run `docker compose exec musicbot node -e "const f='/data/config.json',c=require(f);c.web.passwordHash='';require('fs').writeFileSync(f,JSON.stringify(c,null,2))"`, then `docker compose restart musicbot`. Then open the dashboard to set a new one.
- **Back up** the `bot-data` volume if you want to keep settings. It contains secrets.

## Updating

```bash
git pull                         # or copy the new files over
docker compose pull bgutil-provider
docker compose up -d --build     # also rebuilds the sign-in browser with the latest Chromium
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Dashboard says *Discord refused the "Message Content" intent* | Enable **Message Content Intent** in the Developer Portal (Bot page), then press **Restart bot** |
| Bot ignores `!play` | Check the prefix in Settings, and that the bot can view and send messages in that channel |
| "YouTube is asking the bot to sign in" | Click **Sign in to YouTube** (see above), then press **Test YouTube playback** |
| **Finish** says no signed-in account was found | Finish signing in until YouTube shows your profile picture, then click Finish again |
| Google says "This browser or app may not be secure" | Use **Advanced: paste cookies manually** with cookies exported from your normal browser |
| "The sign-in browser container is not running" | Run `docker compose up -d` so the `youtube-login` container starts |
| HTTP 403 errors or tracks skip instantly | Press **Update yt-dlp now**; check the **Logs** page |
| A Spotify song plays the wrong version | The match shows on the dashboard under the track. Queue the right YouTube link with `!playnext` |
| Bot joins but is silent | Check that it has **Speak** permission. On stage channels, make it a speaker. |

## Project layout

```
src/
  index.js              startup and shutdown
  config.js             settings store, validation schema, env seeding
  bot/                  Discord client lifecycle, prefix commands, embeds
  player/               per-server queue and playback, yt-dlp → ffmpeg audio pipeline
  sources/              link resolver, yt-dlp wrapper, Spotify client, Spotify→YouTube matcher, cookies,
                        YouTube sign-in (drives the sign-in browser and exports its session)
  tools/                cookie export helper (runs on yt-dlp's Python)
  web/                  Express REST API, Socket.IO live updates, auth, sign-in browser proxy, dashboard (public/)
login-browser/          the sign-in browser image: Chromium + Xvfb + x11vnc + noVNC, with a small control API
Dockerfile              Node 24 + ffmpeg + yt-dlp (with its JS challenge solver) in one image
docker-compose.yml      bot + bgutil PO-token provider + sign-in browser
```

Audio path: `yt-dlp` → 8 MB read-ahead buffer → `ffmpeg` (48 kHz PCM, optional loudnorm) → inline volume → Opus → `@discordjs/voice`, which handles Discord's DAVE end-to-end encryption.
