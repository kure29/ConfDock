# Linux/systemd deployment

This is a copy-and-adapt example for a Linux x86-64 host using systemd. The
backend remains on loopback; terminate HTTPS with a distribution-managed Nginx
or Caddy reverse proxy. Debian/Ubuntu commands are shown as examples and do
not make Debian the only supported distribution. ARM64 and other deployment
managers are outside this slice.

## Install and initialize

Run the following as an administrator, adapting paths to your host. Do not put
an administrator password in a shell command, environment file, or
configuration file.

```bash
sudo addgroup --system confdock
sudo adduser --system --ingroup confdock --home /var/lib/confdock --no-create-home confdock
sudo install -d -o confdock -g confdock -m 700 /var/lib/confdock
sudo install -d -o root -g confdock -m 750 /etc/confdock
sudo install -m 755 ./confdock /usr/local/bin/confdock
sudo install -o root -g confdock -m 640 ./config.toml /etc/confdock/config.toml
sudo install -o root -g root -m 644 deploy/systemd/confdock.service /etc/systemd/system/confdock.service
sudo install -o root -g root -m 600 deploy/systemd/confdock.env.example /etc/confdock/confdock.env
```

Before the database is initialized, edit the installed configuration and set
the final external origin. Keep the listener on loopback when a reverse proxy
terminates public HTTP or HTTPS traffic:

```bash
sudoedit /etc/confdock/config.toml
```

For example:

```toml
listen = "127.0.0.1:8787"
public_url = "https://cd.example.com"
```

Check that exact configuration before starting a service:

```bash
sudo -u confdock /usr/local/bin/confdock \
  --config /etc/confdock/config.toml \
  config check
```

Initialize the fixed `admin` account from a real interactive TTY, as the final
service user. The command prompts for the password without putting it in the
process list or shell history:

```bash
sudo -u confdock /usr/local/bin/confdock \
  --config /etc/confdock/config.toml \
  admin init
```

This manual command does not load the systemd `EnvironmentFile`. The configured
public URL (including `CONFDOCK_PUBLIC_URL`, when explicitly supplied to a
first-run process) is only an initialization input while the database has no
`instance_settings` row. After `admin init`, the database value is authoritative
and later environment changes do not replace it. Change the external origin
from the authenticated ConfDock Settings page after initialization. Changing
it does not change `listen`.

Only after initialization succeeds, load and start systemd:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now confdock
sudo systemctl status --no-pager confdock
curl -fsS http://127.0.0.1:8787/healthz
```

The service has no TTY and therefore must not be started before `admin init`.
For controlled automation, `CONFDOCK_BOOTSTRAP_PASSWORD` may be supplied for a
single first initialization and then removed; it is not the recommended
interactive path and must never be committed.

The unit writes SQLite, WAL, and SHM files under `/var/lib/confdock`.
`ProtectSystem=full`, `ReadWritePaths`, `UMask=0077`, and the dedicated user
are intentional boundaries; change them only after testing the resulting
permissions on your host.

See [the backup and restore runbook](../../docs/backup-and-restore.md) before
upgrades or migrations. In particular, stop the service before backing up the
data directory so a live SQLite WAL cannot be missed.

## HTTPS reverse proxy

Configure the distribution's generic Nginx or Caddy HTTPS proxy to forward to
`127.0.0.1:8787`. The external HTTPS origin must already have been placed in
`config.toml` before `admin init`, or must be changed later through the
authenticated Settings page. Set `CONFDOCK_COOKIE_SECURE=true` in
`/etc/confdock/confdock.env` before starting the service behind HTTPS. The
public URL setting does not change the listener or the Secure-cookie setting.
Do not expose the internal listener directly to the Internet.

## Upgrades

Stop the service, back up the complete data directory and `/etc/confdock`
configuration set, replace `/usr/local/bin/confdock`, then start the service again.
Migrations run at startup. A database written by a newer schema must not be
opened for writes by an older binary; roll back the application and its data
backup together.
