# Debian 13 + systemd example

This example keeps ConfDock on loopback and lets 1Panel/OpenResty terminate
HTTPS. Create a dedicated unprivileged `confdock` user and data directory,
copy the binary to `/usr/local/bin/confdock`, and install the unit and env file:

```bash
sudo install -d -o confdock -g confdock -m 700 /var/lib/confdock
sudo install -d -m 755 /etc/confdock
sudo install -m 644 deploy/systemd/confdock.service /etc/systemd/system/confdock.service
sudo install -m 600 deploy/systemd/confdock.env.example /etc/confdock/confdock.env
sudo systemctl daemon-reload
sudo systemctl enable --now confdock
curl -fsS http://127.0.0.1:8787/healthz
```

Edit the environment file before starting. Put the first-run bootstrap password
there only for the initial start and remove it after the administrator exists.
The service writes SQLite, WAL, and SHM files under `/var/lib/confdock`.
`ProtectSystem=full`, `ReadWritePaths`, and `UMask=0077` are intentionally
limited to this verified data path; adjust them only after testing your host.

Upgrade safely by backing up SQLite, stopping the service, replacing the
binary, and starting it again. Migrations run automatically at startup. Do not
downgrade to an older binary and continue writing a database after a newer
schema migration has run.
