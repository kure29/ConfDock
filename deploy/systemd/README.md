# Linux x86-64 + systemd example

This example targets Linux x86-64 glibc with systemd as the native service
manager. Debian 13 has been verified; other distributions and ARM64 are not
claimed. Keep ConfDock on loopback and terminate HTTPS with a distribution-managed Nginx or Caddy reverse proxy. Create a dedicated
unprivileged `confdock` user and data directory, copy the binary to
`/usr/local/bin/confdock`, and install the unit:

```bash
sudo addgroup --system confdock
sudo adduser --system --ingroup confdock --home /var/lib/confdock --no-create-home confdock
sudo install -d -o confdock -g confdock -m 700 /var/lib/confdock
sudo install -m 755 ./confdock /usr/local/bin/confdock
sudo install -d -o root -g confdock -m 750 /etc/confdock
sudo install -m 640 -o root -g confdock ./config.toml /etc/confdock/config.toml
sudo install -m 644 deploy/systemd/confdock.service /etc/systemd/system/confdock.service
sudo systemctl daemon-reload
sudo systemctl enable confdock
sudo systemctl start confdock
curl -fsS http://127.0.0.1:8787/healthz
```

Before starting systemd, initialize the administrator from an interactive
terminal (the service itself has no TTY):

```bash
sudo -u confdock /usr/local/bin/confdock admin init --config /etc/confdock/config.toml
```

The service unit intentionally has no environment file and no bootstrap
password. Never put a password in `config.toml`; initialize it from a TTY
before enabling the service. A direct interactive `confdock --config ...` start
can initialize an empty database automatically and continue serving.
The service writes SQLite, WAL, and SHM files under `/var/lib/confdock`.
`ProtectSystem=full`, `ReadWritePaths`, and `UMask=0077` are intentionally
limited to this verified data path; adjust them only after testing your host.

Upgrade safely by backing up SQLite, stopping the service, replacing the
binary, and starting it again. Migrations run automatically at startup. Do not
downgrade to an older binary and continue writing a database after a newer
schema migration has run.
