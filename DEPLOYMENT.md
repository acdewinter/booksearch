# Deploying Shelfmark on Coolify

The app runs as one small container built from the `Dockerfile` in this
repository. It keeps its database in `/data`, so the only thing you must set up
besides the app itself is a persistent volume at that path.

Menu names below are from Coolify v4 and can differ slightly between versions.

## 1. Put the code on GitHub

The repository is already initialised and committed locally. Your list file
(`TrainFiles_*.txt`) is deliberately not part of it: it is in `.gitignore`, and
you load it through the app after deploying.

1. Create a new repository on GitHub. A **private** one is a good idea.
   Do not tick "Add a README" (the repository should start empty).
2. From this folder, connect and push:

   ```
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```

## 2. Create the app in Coolify

1. Open your project in Coolify and choose **+ New** → **Resource**.
2. Pick the source:
   - **Private Repository (with GitHub App)** for a private repository. Coolify
     walks you through connecting GitHub the first time. This also gives you
     automatic redeploys when you push.
   - **Public Repository** if you made it public: paste the repository URL.
3. Select the repository and the `main` branch.
4. Set **Build Pack** to **Dockerfile**. (The default, Nixpacks, is not needed.)
   Leave the base directory as `/` and the Dockerfile location as `/Dockerfile`.
5. Continue to the configuration screen, but do not deploy yet.

## 3. Configure it

On the application's configuration page:

**General**

- **Domains**: the address you want, for example
  `https://books.your-domain.example`. With a real domain Coolify fetches an
  HTTPS certificate for you. For LAN-only use, an `http://` address or the
  server's IP and a mapped port also works.
- **Ports Exposes**: `3000`

**Persistent Storage** (this step matters)

Add a **Volume Mount**:

- Name: `shelfmark-data` (any name)
- Destination Path: `/data`

Without this volume the list has to be uploaded again after every redeploy.

**Environment Variables** (all optional)

| Name            | Suggested value | Why |
|-----------------|-----------------|-----|
| `APP_PASSWORD`  | a password of your choice | Makes the browser ask for a password. Set this if the address is reachable from the internet, because anyone who can open the app can also replace the list. |
| `APP_USERNAME`  | leave empty     | Only set it if you also want a specific username to be required. |
| `MAX_UPLOAD_MB` | leave empty     | Upload limit, 512 MB by default. The current list is about 31 MB. |

**Health check**

The Dockerfile already contains one (`/healthz`). If Coolify shows its own
health check settings, either leave them enabled with path `/healthz` and port
`3000`, or leave them off and let the Dockerfile's check do the work.

## 4. Deploy and load the list

1. Press **Deploy** and wait for the build to finish. It is quick, because
   there are no packages to install.
2. Open the app's address. It says **No list loaded yet**.
3. Choose your `TrainFiles_*.txt` file and press **Load list**. The current
   list (about 320,000 files) is ready a few seconds after the upload ends.

That's it. The search box is ready as soon as the progress bar finishes.

## Updating the list later

Open the app, press **Update list** (top right), choose the new text file and
press **Replace list**. The new file replaces everything. If it cannot be
read, the current list stays exactly as it was.

## Updating the app later

Push your changes to GitHub. With the GitHub App source, Coolify redeploys on
its own; otherwise press **Redeploy**. The list survives because it lives in
the `/data` volume. If an app update changes the database layout, the app
rebuilds the database from the stored list file by itself when it starts.

## Good to know

- **Copying over plain http**: browsers only allow the modern clipboard on
  `https://` addresses (and `localhost`). On a plain `http://` LAN address the
  app falls back to an older copy method, and if the browser blocks that too it
  shows the text selected so you can press Ctrl+C. Using an HTTPS domain avoids
  all of this.
- **Cloudflare in front**: Cloudflare's free plan rejects uploads over 100 MB.
  The current list is well under that.
- **Resources**: in testing the container sat at about 85 MB of memory with
  the full list loaded, and loaded it without trouble under a 512 MB limit.
  The database for the current list is about 80 MB on disk, plus about 31 MB
  for the stored copy of the list.
- **Backups**: nothing in `/data` is irreplaceable. If the volume is lost,
  upload the list file again.
- **Bind mount instead of a volume**: the container runs as the unprivileged
  `node` user (id 1000). If you mount a host folder at `/data` instead of a
  Docker volume, make it writable for that user: `chown 1000:1000 /your/folder`.

## Troubleshooting

| What you see | What to do |
|--------------|------------|
| "No list loaded yet" after every redeploy | The `/data` volume is missing. Add it under Persistent Storage and redeploy. |
| Upload fails with "larger than the … MB limit" | Raise `MAX_UPLOAD_MB` and redeploy. |
| Upload stops partway through | A proxy in front of Coolify is cutting it off (size or time limit). Check that proxy's upload limits. |
| "No command lines found" | The file is not a list in the expected format: each command must be on its own line and start with `!`. |
| The app logs `EACCES` or "permission denied" for `/data` | The mounted folder is not writable by user id 1000 (see the bind mount note above). |

## Running it without Coolify

On any machine with Docker:

```
docker compose up -d --build
```

Then open `http://that-machine:3000`. The list is kept in the
`shelfmark-data` volume defined in `docker-compose.yml`.
