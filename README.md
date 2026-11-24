# Shelfmark

Search a big list of audiobook commands and copy the one you need.

The list is a text file where every file has a line like this:

```
!TrainFiles f77467ded33c | Aaron, Rachel - By a Silver Thread (audiobook).zip ::INFO:: 306.00MB
```

Shelfmark loads that file into a database, lets you search it by author, title,
series or show, and copies the command (everything from `!` to the file
extension) to your clipboard with one click.

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
- **Books and audio / All files**: covers, logs, cue sheets and playlists are
  hidden unless you switch to *All files*.
- **Update list**: upload a newer copy of the text file. It replaces the whole
  list. If the new file cannot be read, the current list is left untouched.

## Run it on your own computer

Needs [Node.js](https://nodejs.org) 24 or newer. There is nothing to install
or build: the app uses only what ships with Node.

```
npm start
```

Open <http://localhost:3000> and upload your list file. To load a list from the
command line instead (with the server stopped):

```
npm run import -- path/to/list.txt
```

## Deploying

See [DEPLOYMENT.md](DEPLOYMENT.md) for Coolify, step by step.

## Settings

All optional, set as environment variables (or in a `.env` file locally, see
`.env.example`).

| Variable        | Default  | What it does |
|-----------------|----------|--------------|
| `PORT`          | `3000`   | Port the app listens on. |
| `DATA_DIR`      | `./data` (`/data` in Docker) | Where the database and the uploaded list are kept. |
| `APP_PASSWORD`  | empty    | If set, the browser asks for this password before showing anything. |
| `APP_USERNAME`  | empty    | If set together with the password, this exact username is required too. |
| `MAX_UPLOAD_MB` | `512`    | Largest list file that can be uploaded. |

## How it works

- `server/parse.js` reads the list format. A line starting with `/` names the
  folder for the commands that follow; a line starting with `!` is a command.
- `server/build.js` writes a fresh SQLite database (tables `folders` and
  `files`, plus full-text indexes) into its own file. Only when that succeeds
  is it swapped in for the live one.
- `server/library.js` runs the searches. `server/index.js` is the web server.
- `public/` is the page itself: plain HTML, CSS and JavaScript, no build step.
- The data folder holds `library.db` (the database) and `source.txt` (the last
  list you uploaded, kept so the database can be rebuilt after an app update).

## Tests

```
npm test
```

## Fonts

Bricolage Grotesque (SIL Open Font License) and Ubuntu Sans Mono (Ubuntu Font
Licence) are bundled in `public/fonts`, so the app makes no outside requests.
