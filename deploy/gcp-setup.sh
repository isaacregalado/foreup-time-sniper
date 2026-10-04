#!/bin/bash
# GCP us-west1 (Oregon) provisioning for Bethpage Turbo Sniper — FREE TIER.
# Idempotent: safe to re-run (re-running also re-syncs the code + .env).
#
# Free tier = 1× e2-micro in us-west1/us-central1/us-east1 + 30GB pd-standard
# + 1GB egress/mo per billing account. e2-micro has 1GB RAM — a 2GB swapfile
# is added so headless Chromium fits.
#
# CRITICAL for this tool: the VM clock must be America/New_York — turbo.ts
# computes "7:00pm" in LOCAL time. A UTC VM would fire at 3pm ET.
set -euo pipefail

PROJECT="${GCP_PROJECT:-open-487121}"   # billing-enabled, no other instances
ZONE="us-west1-b"                       # Oregon — same region as foreUP's AWS us-west-2
NAME="bethpage-sniper"
MACHINE="e2-micro"                      # always-free tier
IMAGE_FAMILY="debian-12"
IMAGE_PROJECT="debian-cloud"
SSH=(gcloud compute ssh "$NAME" --zone="$ZONE" --project="$PROJECT" --quiet)

echo "→ Project: $PROJECT  Zone: $ZONE  Machine: $MACHINE (free tier)"
gcloud services enable compute.googleapis.com --project="$PROJECT"

# Default network + SSH rule (a fresh project may not have them yet)
if ! gcloud compute networks describe default --project="$PROJECT" >/dev/null 2>&1; then
  echo "→ Creating default network"
  gcloud compute networks create default --subnet-mode=auto --project="$PROJECT"
fi
if ! gcloud compute firewall-rules describe default-allow-ssh --project="$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create default-allow-ssh \
    --network=default --allow=tcp:22 --source-ranges=0.0.0.0/0 --project="$PROJECT"
fi

# Create VM if missing
if ! gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$PROJECT" >/dev/null 2>&1; then
  echo "→ Creating $NAME"
  gcloud compute instances create "$NAME" \
    --project="$PROJECT" \
    --zone="$ZONE" \
    --machine-type="$MACHINE" \
    --image-family="$IMAGE_FAMILY" \
    --image-project="$IMAGE_PROJECT" \
    --boot-disk-size=30GB \
    --boot-disk-type=pd-standard \
    --tags=bethpage-sniper
else
  echo "→ $NAME already exists"
fi

echo "→ Waiting for SSH..."
until "${SSH[@]}" --command='echo ready' 2>/dev/null; do sleep 5; done

echo "→ Base setup: timezone, swap, Node 20, tmux"
"${SSH[@]}" --command='
set -e
sudo timedatectl set-timezone America/New_York
sudo timedatectl set-ntp true
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y -q tmux rsync >/dev/null
date  # visual confirmation: must print EDT/EST
'

echo "→ Syncing project to VM"
"${SSH[@]}" --command='mkdir -p ~/bethpage-sniper/logs'
gcloud compute scp --recurse --zone="$ZONE" --project="$PROJECT" --quiet \
  ~/bethpage-sniper/src ~/bethpage-sniper/scripts ~/bethpage-sniper/static \
  ~/bethpage-sniper/package.json ~/bethpage-sniper/package-lock.json \
  ~/bethpage-sniper/tsconfig.json ~/bethpage-sniper/.env ~/bethpage-sniper/auth \
  "$NAME":~/bethpage-sniper/

# SPEC's sheet library both ways (unique immutable snapshot names — copying a
# same-named file again is a no-op in content). Public tee-sheet rows only.
echo "→ Merging the SPEC sheet library both ways"
mkdir -p ~/bethpage-sniper/logs/sheets
"${SSH[@]}" --command='mkdir -p ~/bethpage-sniper/logs/sheets'
if compgen -G "$HOME/bethpage-sniper/logs/sheets/*.json" >/dev/null; then
  gcloud compute scp --zone="$ZONE" --project="$PROJECT" --quiet \
    ~/bethpage-sniper/logs/sheets/*.json "$NAME":~/bethpage-sniper/logs/sheets/
fi
gcloud compute scp --recurse --zone="$ZONE" --project="$PROJECT" --quiet \
  "$NAME":~/bethpage-sniper/logs/sheets ~/bethpage-sniper/logs/ || echo "  (no remote sheets yet)"

echo "→ npm install + Playwright Chromium (slow on e2-micro — several minutes)"
"${SSH[@]}" --command='
set -e
cd ~/bethpage-sniper
chmod 600 .env auth/session.json 2>/dev/null || true
grep -q "^HEADLESS=1" .env || echo "HEADLESS=1" >> .env   # no display on a VM
npm ci --no-audit --no-fund
sudo npx playwright install-deps chromium
npx playwright install chromium
'

# If the always-on dashboard service exists on the VM, restart it so it picks
# up the freshly synced code (.env is re-read per request; code is not).
"${SSH[@]}" --command='sudo systemctl restart sniper-dashboard 2>/dev/null && echo "→ VM dashboard restarted" || true'

echo ""
echo "→ RTT from VM to foreupsoftware.com (NY residential is ~70ms):"
"${SSH[@]}" --command='
for i in 1 2 3; do
  curl -o /dev/null -s -w "  TCP+TLS+TTFB: %{time_starttransfer}s\n" https://foreupsoftware.com/index.php/booking/19765/2432
done
'

echo ""
echo "✓ VM ready."
echo "  Systems check:  gcloud compute ssh $NAME --zone=$ZONE --project=$PROJECT --command='cd ~/bethpage-sniper && npm run turbo:dry'"
echo "  Sunday (auto):  gcloud compute ssh $NAME --zone=$ZONE --project=$PROJECT -- -t 'cd ~/bethpage-sniper && tmux new -A -s snipe \"AUTO_BOOK=1 npx tsx src/turbo.ts --race\"'"
echo "  Dashboard:      gcloud compute ssh $NAME --zone=$ZONE --project=$PROJECT -- -L 4747:localhost:4747 → then http://localhost:4747 on the Mac"
