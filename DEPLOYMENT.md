# Deploying Shelfmark

Shelfmark is one small Node.js program with no packages to install. It keeps
two kinds of things on disk:

- **Its own data** (`DATA_DIR`): the search database, the list files you
  uploaded, your IRC settings, the download queue, and the collection (which
  file is which book, and how far each was read).
- **Downloaded files** (`DOWNLOAD_DIR`): whatever arrives over IRC. This
  folder is also what the Collection page and the reader app show, so it is
  worth mounting somewhere that lasts.

## Where to run it

Both of these work. Pick by where your storage lives.

| | Proxmox LXC (recommended for downloading) | Coolify |
|---|---|---|
| Downloads on your ZFS storage | Direct bind mount into the container | Only if the Coolify machine can see that storage (a folder on the host, or a network share mounted there) |
| Updating the app | `git pull`, run the install script again | Automatic on every push |
| What an update interrupts | Only when you choose to run it | Every redeploy drops the IRC connection and any running transfer (transfers resume when asked for again) |
| HTTPS and a domain | Put your existing reverse proxy in front, or use it on the LAN | Built in |

The recommendation is the LXC: the files land straight on ZFS with no network
share in between, and a long download is never cut off by an automatic
redeploy. If you only want search and copy, Coolify is the simpler choice.

Not tested here: the install script was run on clean Debian 12 and 13 systems
and the app was run from the result, but not on Proxmox itself, and the step
that starts the systemd service could not be exercised. If the service does
not start, `journalctl -u shelfmark -n 50` says why.

---

## Option A: Proxmox LXC

### 1. Create the container

In the Proxmox web interface, **Create CT**:

- Template: Debian 13 (Debian 12 and recent Ubuntu also work)
- Unprivileged container: yes
- Disk 4 GB, 1 core, 512 MB memory
- Network: an address on your LAN (DHCP or static)

### 2. Mount the download folder

On the **Proxmox host** (not inside the container), mount the ZFS folder at
`/downloads` in the container. Replace `105` with the container's ID and the
first path with your own:

```
pct set 105 -mp0 /tank/media/audiobooks/incoming,mp=/downloads
```

### 3. Folder permissions

The app runs as its own user, `shelfmark`, and that user has to be able to
write to the mounted folder.

In an unprivileged container, user id `N` inside the container is user id
`100000 + N` on the Proxmox host. So decide which id the app should use, and
make the folder writable for it:

- **You already share this storage with other containers** under a common id
  (say 1000): reuse it. Install with `RUN_UID=1000 RUN_GID=1000` in step 4.
  Nothing to change on the host.
- **Otherwise**: pick an id (1000 is fine), install with it in step 4, and on
  the Proxmox host hand the folder to the matching host id:

  ```
  chown -R 101000:101000 /tank/media/audiobooks/incoming
  ```

Downloaded files are created readable and writable by the user and its group.

### 4. Install

Inside the container (`pct enter 105`), as root:

```
apt-get update && apt-get install -y git
git clone https://github.com/YOUR-USERNAME/YOUR-REPO.git /root/shelfmark
cd /root/shelfmark
RUN_UID=1000 RUN_GID=1000 bash deploy/install-lxc.sh
```

For a private repository, `git clone` asks for a GitHub username and a
personal access token. Copying the folder into the container works as well;
the script only needs the files.

The script installs Node.js 24, copies the app to `/opt/shelfmark`, creates
the `shelfmark` user, writes `/etc/shelfmark.env` and starts the service. It
warns you at the end if the app cannot write to `/downloads`.

### 5. Set a password

Anyone who can open the app can also use its IRC connection, so set a
password unless only you can reach it:

```
nano /etc/shelfmark.env        # fill in APP_PASSWORD=
systemctl restart shelfmark
```

To sign in with your Hardcover account instead (or as well), and to get the
Library page, add `HARDCOVER_CLIENT_ID=` and `HARDCOVER_CLIENT_SECRET=` to the
same file; the README explains where they come from under *Signing in*.
Hardcover only redirects back to an `https` address (or to `localhost`), so
this needs your reverse proxy in front of the container.

Then open `http://CONTAINER-ADDRESS:3000`, upload your list, and continue with
[Connecting to IRC](#connecting-to-irc).

### Updating

```
cd /root/shelfmark && git pull && bash deploy/install-lxc.sh
```

Your settings, list and queue are kept. A running transfer stops and continues
from where it was when you ask for the file again.

### Useful commands

```
systemctl status shelfmark      # is it running
journalctl -u shelfmark -f      # what it is doing
systemctl restart shelfmark     # after changing /etc/shelfmark.env
```

---

## Option B: Coolify

Menu names below are from Coolify v4 and can differ slightly between versions.

### 1. Put the code on GitHub

Your list file (`TrainFiles_*.txt`) is deliberately not part of the
repository: it is in `.gitignore`, and you load it through the app.

```
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

### 2. Create the app

1. In your project choose **+ New** → **Resource**.
2. Pick **Private Repository (with GitHub App)** (or **Public Repository**).
3. Select the repository and the `main` branch.
4. Set **Build Pack** to **Dockerfile**. Leave the base directory as `/`.

### 3. Configure it

**General**

- **Domains**: for example `https://books.your-domain.example`
- **Ports Exposes**: `3000`

**Persistent Storage** (both matter)

1. A **Volume Mount** for the app's own data:
   - Name: `shelfmark-data`
   - Destination Path: `/data`
2. A **Directory Mount** (bind mount) for downloads:
   - Source Path: the folder on the Coolify machine where files should go
   - Destination Path: `/downloads`

   The container runs as user id 1000, so that folder has to be writable for
   id 1000 (`chown 1000:1000 /your/folder` on the Coolify machine). Without
   this mount, downloads are saved inside the container and disappear at the
   next redeploy.

**Environment Variables** (all optional)

| Name            | Suggested value | Why |
|-----------------|-----------------|-----|
| `APP_PASSWORD`  | a password of your choice | Makes the app ask for a password. Set this or the Hardcover pair below: anyone who can open the app can replace the list and use the IRC connection. |
| `APP_USERNAME`  | leave empty     | Only if you also want a specific username to be required. |
| `HARDCOVER_CLIENT_ID`, `HARDCOVER_CLIENT_SECRET` | from your app on Hardcover | Sign in with Hardcover and see your library. Register `https://books.your-domain.example/oauth/callback` as the app's redirect URI. See *Signing in* in the README. |
| `HARDCOVER_ALLOWED_USERS` | leave empty | Hardcover usernames that may sign in. Empty: only the first account that signs in. |
| `APP_URL`       | leave empty     | Your domain, with `https://`. Only if signing in sends you back to the wrong address. |
| `MAX_UPLOAD_MB` | leave empty     | Upload limit for one list file, 512 MB by default. |

**Health check**: the Dockerfile contains one (`/healthz`, port `3000`).

### 4. Deploy

Press **Deploy**, open the address, upload your list, then continue below.

Every redeploy restarts the app: the IRC connection is made again by itself,
and an interrupted transfer continues when you ask for the file again.

---

## Connecting to IRC

1. Open **Downloads** at the top of the app and press **Set up the connection**.
2. Fill in the server address, a nickname and the channel. Leave **Secure
   connection** on if the server supports it (port 6697); turn it off for
   plain connections (port 6667).
3. Press **Save and connect**.

From then on, clicking a file in the search results sends its command to the
channel, and the file is saved to the download folder when the bot sends it.
The app reconnects by itself after a restart or a lost connection, until you
press **Disconnect**.

Under **More options** you can set a nickname password (for a registered
nickname), a channel key, and how patiently requests are sent.

### Which files are accepted

- A file is accepted automatically when it comes from the bot you asked. The
  bot's nickname is taken from the command: `!TrainFiles …` means the bot is
  called `TrainFiles`.
- A file you did not ask for, from a sender that is in your lists (any
  nickname your loaded lists have commands for), shows up under **Downloads**
  with **Accept** and **Decline**. Nothing is fetched until you accept.
- A file from anyone else is refused: it never reaches the queue, and a line
  under **Messages** says who tried. Anyone on the IRC server can offer you a
  file, so this is what keeps strangers out while the app stays connected.
- Two ways to let someone else through, both under **Settings → More
  options**: list their nickname under **Also accept files from** (their
  files are then accepted without asking), or turn off **Only take files from
  senders in your lists** (everyone is back to **Accept** and **Decline**).
  You need one of them for a bot whose list you do not have yet, such as when
  asking a new bot for its list.
- A nickname is all IRC gives to go by: whoever holds a bot's nickname
  counts as that bot. Networks where the bots register their nicknames rule
  that out; the app cannot check it by itself.
- Files are only ever written inside the download folder. A file that is
  still arriving has `.part` at the end of its name.

## Senders behind a firewall (reverse DCC)

Normally the app connects out to the sender, which needs nothing from your
network. Some senders cannot accept connections and ask the app to accept one
instead. The app refuses those unless you set this up:

1. Choose a few ports and set `DCC_PORTS`, for example `DCC_PORTS=50000-50010`
   (`/etc/shelfmark.env` in the LXC, an environment variable in Coolify).
2. Forward those TCP ports from your router to the machine running the app.
   In Coolify, also publish them (**Ports Mappings**: `50000-50010:50000-50010`).
3. If transfers still fail, set `DCC_PUBLIC_IP` to your public IP address. The
   app tries to work it out from the IRC server, which fails on networks that
   hide your address.

Skip all of this until a download fails with a message that mentions
`DCC_PORTS`.

## Good to know

- **Copying over plain http**: browsers only allow the modern clipboard on
  `https://` addresses (and `localhost`). On a plain `http://` LAN address the
  app falls back to an older copy method, and if the browser blocks that too
  it shows the text selected so you can press Ctrl+C.
- **A proxy in front of the app** must not buffer or cut off long-lived
  responses, or the Downloads page stops updating by itself (it catches up on
  reload). Coolify's proxy is fine as it is. Cloudflare's free plan also
  rejects uploads over 100 MB; the current list is well under that.
- **Resources**: memory and disk grow with the lists. Measured with the
  audiobook list (320,000 files) and a 1.7-million-file ebook list loaded
  together: about 95 MB of memory while running and 330 MB at the peak of
  loading, and 550 MB on disk. The database is built again each time a list
  is added, replaced or removed, and for a moment the old and the new one
  exist side by side, so allow about 1 GB of disk for the data folder.
- **The reader app** talks to the same address you open Shelfmark at. Over
  the internet that should be an `https://` address; on the home network a
  plain `http://192.168.x.x:3000` works too. It fetches whole books, so a
  proxy in front must allow answers of a few hundred megabytes, and it needs
  the `Authorization` header passed through (proxies do that unless told not
  to).
- **Backups**: `collection.json` in the data folder is the one file that is
  work to redo: it holds which file is which book and where everyone is in
  their books. The lists can be uploaded again. The file `irc-settings.json` in
  the data folder holds your IRC settings, including any passwords you saved,
  and `hardcover/accounts.json` holds the tokens for your Hardcover account
  (they can read your library, nothing else). Treat the data folder as private.

## Troubleshooting

| What you see | What to do |
|--------------|------------|
| "No list loaded yet" after every redeploy | The `/data` volume is missing (Coolify). Add it and redeploy. |
| Downloads vanish after a redeploy | The `/downloads` mount is missing (Coolify). |
| "The download folder cannot be used: the download folder is not writable" | The app's user cannot write there. See *Folder permissions* (LXC) or the Directory Mount note (Coolify). |
| A request stays on "Waiting for TrainFiles to come back" | The bot is not in the channel. The request is sent when it returns, or press **Send anyway**. |
| A request stays on "Asked …" | The bot has a queue of its own; check **Messages** on the Downloads page for what it said. |
| "…offered the file from … a private network" | The sender announced an address that cannot be reached. Only if the sender really is on your own network: turn on **Allow senders on a private network**. |
| "The sender did not answer" | The sender's port is closed from where the app runs, or outgoing connections are blocked by your firewall. |
| "Could not join #channel …" | The message says why (key, invite-only, registered nicknames only). Fix it in **Settings** and press **Try joining again**. |
| The server's certificate "could not be verified" | Only for a server you trust: turn off **Check the server's security certificate** under More options. |
| Upload of the list fails with "larger than the … MB limit" | Raise `MAX_UPLOAD_MB`. |
| Hardcover shows an error instead of asking to approve | The redirect URI registered for the app on Hardcover is not exactly the one the app sends. The app prints the one it expects when it starts; set `APP_URL` if that is not your public address. |
| "Signing in with Hardcover did not work" | The client id or secret is wrong, or the redirect URI differs. The app's log has the reason Hardcover gave. |
| "That Hardcover account is not allowed to use this app" | Someone else's account owns the app, or yours is not in `HARDCOVER_ALLOWED_USERS`. To start over, delete `auth.json` in the data folder and restart. |
| The library says a scope is missing | On Hardcover, allow the app `read:me:content`, `read:library` and `read:lists`, then sign in again. |

## Running it with plain Docker

```
docker compose up -d --build
```

Then open `http://that-machine:3000`. Downloads go to `./downloads` next to
`docker-compose.yml`; set `DOWNLOAD_PATH` in `.env` to use another folder.
