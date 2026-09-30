# babycupsy backend — Ubuntu deployment guide

Run these on the **server** over SSH (not on your Windows machine). Assumes a fresh
**Ubuntu 22.04/24.04 LTS** VPS and a sudo-capable user.

- API (this backend): **https://api.babycupsey.com**
- Frontend site: **https://babycupsey.com**

---

## 0. Prerequisites

- A server you can SSH into: `ssh youruser@SERVER_IP`
- **DNS:** an `A` record for `api.babycupsey.com` → `SERVER_IP` (do this first; certbot in
  step 10 fails until it resolves). Verify: `nslookup api.babycupsey.com`

> **Current deployment:** `api.babycupsey.com` already resolves to **165.22.241.154**
> (DigitalOcean) and nginx is installed there — this record is done.
> The frontend `babycupsey.com` is hosted on **Netlify** (`www` 301s to the apex), *not*
> on this server, so the droplet only ever needs the one api vhost + cert.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git build-essential curl ufw
```

## 1. Node.js 20 LTS + npm

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # expect v20.x  (backend requires >= 20)
npm -v    # npm ships with nodejs, no separate install
```

## 2. MongoDB (REQUIRED — the backend exits if it can't connect)

Pick **one**:

### Option A — MongoDB Atlas (managed, simplest)
1. Create a free M0 cluster at https://www.mongodb.com/atlas
2. Add a database user + allow `SERVER_IP` under Network Access.
3. Copy the SRV string for `.env` → `MONGODB_URI=mongodb+srv://user:pass@cluster.xxxx.mongodb.net`
4. Skip to step 3.

### Option B — local MongoDB Community 7.0
```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
  | sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
mongosh --eval 'db.runCommand({ ping: 1 })'   # expect { ok: 1 }
```
> Ubuntu 24.04 (noble): keep the `jammy` line above (7.0 has no noble repo), or use the
> `8.0` repo with codename `noble`. Local URI = `mongodb://127.0.0.1:27017`.

## 3. pm2 (keeps the backend running, restarts on crash/boot)

```bash
sudo npm install -g pm2
pm2 -v
```

## 4. nginx + certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 5. Clone the backend

```bash
sudo mkdir -p /var/www
sudo chown -R "$USER":"$USER" /var/www
cd /var/www
git clone https://github.com/blockfile/cupsy.git
cd cupsy
npm install
```

## 6. Configure the environment

```bash
cp .env.example .env
nano .env
```

Set at minimum:
```
PORT=3000

# Keep TRUE until you are ready to move real funds (simulates everything, safe).
DRY_RUN=true

# Trigger: check the fee vault every minute, claim once it holds >= 0.25 SOL.
POLL_SCHEDULE=* * * * *
MIN_CLAIM_SOL=0.25

# Mongo: Atlas SRV string, or the local default below.
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=babycupsy

# Mints
TOKEN_MINT=<your BABYCUPSY mint>
CUPSY_MINT=6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump

# Browser origins allowed to call the API — the frontend, NOT the api host.
CORS_ORIGINS=https://babycupsey.com,https://www.babycupsey.com

# Protects POST /api/run|pause|resume. Generate one: `openssl rand -hex 32`
API_KEY=<long-random-string>

# ── Only when going LIVE (DRY_RUN=false) ──
# RPC_URL=https://<paid-rpc-helius-or-similar>
# WALLET_PRIVATE_KEY=<base58 or JSON-array secret key>
```

Lock the file down — it holds the wallet key:
```bash
chmod 600 .env
```

> **Leave `DRY_RUN=true` for the first boot.** Flip to `false` only after a funded
> `WALLET_PRIVATE_KEY` and a paid `RPC_URL` are set and verified.

## 7. Start with pm2

```bash
cd /var/www/cupsy
pm2 start server.js --name babycupsy
pm2 save
pm2 startup        # prints a `sudo ...` command — copy/paste & run it to enable on boot
pm2 logs babycupsy # watch the logs; Ctrl-C to exit (app keeps running)
```

Verify locally before touching nginx:
```bash
curl http://127.0.0.1:3000/          # babycupsy JSON banner
curl http://127.0.0.1:3000/summary   # headline stats JSON
```

## 8. nginx reverse proxy for api.babycupsey.com

```bash
sudo tee /etc/nginx/sites-available/api.babycupsey.com >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name api.babycupsey.com;

    access_log /var/log/nginx/babycupsy.access.log;
    error_log  /var/log/nginx/babycupsy.error.log;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Server-Sent Events (GET /api/stream): never buffer, hold the connection.
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/api.babycupsey.com /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t                    # must say "test is successful"
sudo systemctl reload nginx
```

## 9. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
sudo ufw status
```

`http://api.babycupsey.com/` should now return the JSON banner.

## 10. HTTPS with certbot

```bash
sudo certbot --nginx -d api.babycupsey.com
sudo certbot renew --dry-run     # confirm auto-renewal works
```

Certbot rewrites the vhost to listen on 443 and adds an HTTP→HTTPS redirect; the SSE
proxy settings from step 8 are preserved. Confirm:

```bash
curl https://api.babycupsey.com/summary
curl -N https://api.babycupsey.com/api/stream   # should print `event: hello` then pings
```

Renewal is automatic via the `certbot.timer` systemd unit — nothing else to schedule.

## 11. Point the frontend at the API

In the frontend (babycupsey.com), set the API base URL to `https://api.babycupsey.com`
and open the SSE stream at `https://api.babycupsey.com/api/stream`. If you change
`CORS_ORIGINS`, run `pm2 restart babycupsy` for it to take effect.

---

## Redeploying / updating

```bash
cd /var/www/cupsy
git pull
npm install            # only if dependencies changed
pm2 restart babycupsy
pm2 logs babycupsy --lines 50
```

## Troubleshooting

| Symptom | Check |
|---|---|
| 502 Bad Gateway | `pm2 status` / `pm2 logs babycupsy` — the app is down or not on PORT 3000 |
| CORS error in browser | `CORS_ORIGINS` must list the frontend origin exactly (scheme + host, no trailing slash), then `pm2 restart babycupsy` |
| SSE connects but no events | `proxy_buffering off` missing from the active vhost (`sudo nginx -T \| grep -A5 proxy_pass`) |
| App won't start | Mongo unreachable — `sudo systemctl status mongod` or Atlas IP allowlist |
| certbot fails | `api.babycupsey.com` A record not resolving to `SERVER_IP` yet, or port 80 blocked |

## Going live (real funds) — checklist
- [ ] Paid `RPC_URL` set (public RPC can't enumerate large holder sets).
- [ ] Funded `WALLET_PRIVATE_KEY` set (needs SOL beyond the 20% reserve for first-run ATA rent).
- [ ] `TOKEN_MINT` is the real BABYCUPSY mint; `CUPSY_MINT` correct.
- [ ] `API_KEY` set to a long random string.
- [ ] `DRY_RUN=false`, then `pm2 restart babycupsy` and watch `pm2 logs babycupsy` for the first cycle.
