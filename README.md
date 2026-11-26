# Shelfmark

Search a big list of audiobook commands, ask for a file over IRC with one
click, and have it saved to a folder of your choice.

The list is a text file where every file has a line like this:

```
!TrainFiles f77467ded33c | Aaron, Rachel - By a Silver Thread (audiobook).zip ::INFO:: 306.00MB
```

Lists without the id and the bar work too (`!Bsk Some Book.epub ::INFO:: 716.79KB`),
as do folder headings written either as `/a/b` or as `a\b` with a row of `=` below.

Shelfmark loads that file into a database and lets you search it by author,
title, series or show. Then either:

- **copy** the command (everything from `!` to the file extension) to your
  clipboard and paste it into your own IRC program, or
- connect Shelfmark itself to the IRC channel, so that clicking a file sends
  the command there and the file the bot sends back (over DCC) is saved to
  your download folder.

Connected to your [Hardcover](https://hardcover.app) account, it also shows
your library, and picking a book there looks for it in the lists.

## Using it

- **Search**: type any words. Every word has to appear in the file name or in
  one of its folders, and each word matches the start of a word, so `sand mist`
  finds Sanderson's Mistborn.
  - `"the stand"` matches the exact phrase.
  - `king -abridged` leaves out anything containing "abridged".
- **Copy**: click a row (or move with <kbd>↓</kbd>/<kbd>↑</kbd> and press
  <kbd>Enter</kbd>). **Copy all** copies every command in that block, one per line.
  Rows you have copied keep a "Copied" mark in that browser, which helps when
  working through a series.
- **Browse**: with the search box empty you can walk the folders (A–Z authors,
  shows). Clicking a folder name anywhere opens it; typing then searches inside
  that folder only.
- **Books and audio / All files**: audio files, archives and ebooks (epub,
  mobi, azw3, pdf, comics and similar) are always shown. Covers, logs, cue sheets and playlists are
  hidden unless you switch to *All files*.
- **Lists** (top right): load as many list files as you like, several at once
  if you want. They are searched together, and each list shows up as a folder
  of its own, so you can still browse or search just one of them. A file that
  looks like a newer copy of a loaded list (same name, different date) is
  offered as a replacement for it; anything else is added. Lists can be
  removed again. If any file cannot be read, nothing changes.

### Your Hardcover library

With Hardcover set up (see [Signing in](#signing-in)), the **Library** page
shows the books you have marked on Hardcover (want to read, reading, read,
paused, did not finish) and the books on your lists, with their covers,
authors, series, ratings and dates.

- Filter by status, by one of your lists, or by typing part of a title,
  author, series or genre. Sort by date added, title, author, series, rating
  or year, and switch between covers and a table.
- **Pick a book** to look for it in the lists. The search page opens with the
  book above the results and the search that found it in the box, where you
  can change it. From there everything works as usual: click a file to ask
  for it, or copy its command.
- File names follow no single convention, so the search is built from what
  they have in common: the author's surname and the telling words of the
  title, without "the", punctuation or subtitle (`sanderson final empire`).
  If that finds nothing, it tries the co-authors, the title before or after a
  colon, the title of your edition and the book's other titles, and then the
  title without an author. The panel shows each search that found something,
  along with the series and everything by the author, so one click widens or
  narrows it.
- The library is copied from Hardcover when you sign in and again when you
  open the page after six hours, or when you press **Sync now**. Nothing is
  ever changed on Hardcover.

### Downloading over IRC

Open **Downloads** and press **Set up the connection**: server, nickname and
channel are all it needs. Once that is saved:

- **Clicking a file asks for it.** The row shows how it is going (Queued,
  Asked, a percentage, Saved). The small copy button at the end of the row
  still copies the command. For a second or two after clicking, **Undo** takes
  the request back before it reaches the channel.
- **Get all** asks for every file in a block, one after the other.
- **Downloads** shows the queue with progress, speed and time left, the
  finished files, and the messages from the server and the bot. You can type
  to the channel there too, or use `/msg nickname text`.
- Requests go out one at a time by default, and wait while the bot is not in
  the channel. Both can be changed under **Settings → More options**.
- A file from the bot you asked is accepted by itself. A file from anyone
  else waits for you to press **Accept**.
- An interrupted download keeps its partial file (`name.part`) and continues
  from there when you press **Try again**.
- The app stays connected, and reconnects after a restart, until you press
  **Disconnect**.

## Run it on your own computer

Needs [Node.js](https://nodejs.org) 24 or newer. There is nothing to install
or build: the app uses only what ships with Node.

```
npm start
```

Open <http://localhost:3000> and upload your list files. To load lists from the
command line instead (with the server stopped):

```
npm run import -- path/to/list.txt path/to/another-list.txt
```

A file with the same name as a loaded list (ignoring the date) replaces it;
any other file is added.

To try the IRC side without touching a real network, start the practice
server in a second terminal. It has a bot called `TrainFiles` that answers
every command with a generated 40 MB file:

```
npm run fake-irc
```

Then set up the connection with server `127.0.0.1`, port `6667`, secure
connection off, any nickname, channel `#books`, and under More options tick
**Allow senders on a private network**.

There is a practice Hardcover too, with a small library whose books are
partly in `test/fixtures/sample-list.txt`. Signing in approves by itself:

```
npm run fake-hardcover
HARDCOVER_CLIENT_ID=practice HARDCOVER_CLIENT_SECRET=practice \
  HARDCOVER_API_URL=http://127.0.0.1:4010 HARDCOVER_WEB_URL=http://127.0.0.1:4010 npm start
```

## Signing in

Out of the box the app is open to anyone who can reach it. There are two ways
to close it, and they can be combined.

**An app password.** Set `APP_PASSWORD` and the app shows a sign-in page.

**Sign in with Hardcover.** This is also what brings your library in.

1. On Hardcover, open **Settings → Hardcover API → Developer Apps** and create
   an app of the type **Web app (server-side)**.
2. As its redirect URI give the address of this app followed by
   `/oauth/callback`, exactly as you open it: `http://localhost:3000/oauth/callback`
   on your own computer, `https://books.example.com/oauth/callback` once it is
   deployed. Hardcover requires `https` for anything but localhost.
3. Allow it the scopes `read:me:content`, `read:library` and `read:lists`.
   Device authorization can stay off.
4. Put the client id and the secret in `HARDCOVER_CLIENT_ID` and
   `HARDCOVER_CLIENT_SECRET`, and restart the app.

Who gets in with Hardcover:

- With `HARDCOVER_ALLOWED_USERS` set (usernames, comma separated): those
  accounts, each with their own library.
- Otherwise only the **owner**: the first account that signs in. If
  `APP_PASSWORD` is set as well, that first time needs the password too (sign
  in with it, then press **Connect Hardcover**), so nobody else can claim the
  app before you. To start over, delete `auth.json` in the data folder.
- Anyone who has signed in with the app password can connect their own
  Hardcover account for as long as that session lasts.

Sessions last 30 days and are kept in `sessions.json`. The Hardcover tokens
(in `hardcover/accounts.json`) only allow reading; **Disconnect Hardcover**
under the account button revokes them and deletes the copy of your library.
The IRC connection and the download queue are shared by everyone who can
sign in.

## Deploying

See [DEPLOYMENT.md](DEPLOYMENT.md) for a Proxmox LXC container or Coolify, step
by step.

## Settings

All optional, set as environment variables (or in a `.env` file locally, see
`.env.example`).

| Variable        | Default  | What it does |
|-----------------|----------|--------------|
| `PORT`          | `3000`   | Port the app listens on. |
| `DATA_DIR`      | `./data` (`/data` in Docker) | Where the database and the uploaded list are kept. |
| `APP_PASSWORD`  | empty    | If set, the app asks for this password before showing anything. |
| `APP_USERNAME`  | empty    | If set together with the password, this exact username is required too. |
| `HARDCOVER_CLIENT_ID`, `HARDCOVER_CLIENT_SECRET` | empty | From your app on Hardcover. With both set, people sign in with Hardcover and get the Library page. See [Signing in](#signing-in). |
| `HARDCOVER_ALLOWED_USERS` | empty | Hardcover usernames that may sign in, comma separated. Empty: only the first account that signs in. |
| `APP_URL`       | empty    | The address people open the app at, such as `https://books.example.com`. Only needed if the redirect to Hardcover comes out with the wrong address behind your proxy. |
| `MAX_UPLOAD_MB` | `512`    | Largest single list file that can be uploaded. |
| `DOWNLOAD_DIR`  | `downloads` inside `DATA_DIR` (`/downloads` in Docker) | Where files received over IRC are saved. |
| `DCC_PORTS`     | empty    | Ports the app may accept connections on, such as `50000-50010`. Only needed for senders behind a firewall; see DEPLOYMENT.md. |
| `DCC_PUBLIC_IP` | empty    | Your public IP address, for the same case, if the app cannot work it out. |

The IRC server, nickname, channel and passwords are set in the app
(**Downloads → Settings**), not here. They are stored in `irc-settings.json`
in the data folder.

## How it works

- `server/parse.js` reads the list format. A line starting with `/` names the
  folder for the commands that follow; a line starting with `!` is a command.
- `server/build.js` writes a fresh SQLite database (tables `folders` and
  `files`, plus full-text indexes) into its own file. Only when that succeeds
  is it swapped in for the live one.
- `server/library.js` runs the searches. `server/index.js` is the web server.
- `server/auth.js` keeps the sessions and decides who may sign in.
- `server/hardcover/client.js` talks to Hardcover (the OAuth sign-in and the
  GraphQL API), `library.js` holds the queries and tidies the answers,
  `service.js` keeps the tokens, the synced libraries and the covers, and
  `routes.js` is their part of the web API.
- `server/match.js` turns a book into the searches that find it in the lists.
- `server/irc/client.js` is the IRC connection, `server/irc/dcc.js` receives
  one file, and `server/irc/manager.js` ties them to the queue and the
  settings. `server/irc/routes.js` is their part of the web API, including
  the live stream of events the page listens to.
- `public/` is the page itself: plain HTML, CSS and JavaScript, no build step.
- `server/lists.js` keeps the list files you loaded. The database is always
  built from all of them together, so adding, replacing or removing a list
  builds it again (about 15 seconds for two million files).
- The data folder holds `library.db` (the database), `lists/` and
  `lists.json` (the list files you loaded, kept so the database can be
  rebuilt after an app update), `irc-settings.json` and `irc-state.json`
  (the download queue), `sessions.json` and `auth.json` (who is signed in, and
  who owns the app), and `hardcover/` (tokens, one synced library per account,
  and the covers).

## Tests

```
npm test
```

The IRC tests run against the practice server in `dev/fake-irc.js` and the
Hardcover tests against the one in `dev/fake-hardcover.js`, so they need no
network.

## Fonts

Bricolage Grotesque (SIL Open Font License) and Ubuntu Sans Mono (Ubuntu Font
Licence) are bundled in `public/fonts`, so the page makes no outside requests.
Book covers are fetched from Hardcover by the server and kept in the data
folder.
