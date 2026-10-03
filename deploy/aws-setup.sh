#!/bin/bash
# AWS us-west-2 (Oregon) provisioning for Bethpage Turbo Sniper.
#
# WHY AWS over the GCP box: foreUP's origin runs on AWS us-west-2. Same
# region/cloud puts the sniper on Amazon's internal network path — ~1-3ms
# RTT vs ~28-35ms from GCP us-west1. The drop is decided in milliseconds.
#
# NOT free tier: t3.small ≈ $0.0208/hr (~$15/mo left running) + ~$1.60/mo
# for the 20GB gp3 volume. Stop it between drops (command printed at the end);
# note the public IP changes on stop/start — re-run this script to reconnect.
#
# CRITICAL: the VM clock must be America/New_York — turbo.ts computes
# "7:00pm" in LOCAL time. A default-UTC EC2 box fires at 3pm ET.
#
# Requires: awscli v2 configured (`aws configure`, region us-west-2) with EC2
# permissions. Idempotent: re-running reuses the instance (found by Name tag),
# restarts it if stopped, and re-syncs code + .env — same gesture as gcp-setup.sh.
#
# ⚠ ONE MACHINE PER DROP: ForeUp allows one pending reservation per account.
# If this box runs a drop, the GCP VM and the Mac must sit it out.
set -euo pipefail

REGION="us-west-2"                     # Oregon — foreUP's own region
AZ="${AWS_AZ:-us-west-2a}"             # pinned AZ
TYPE="${AWS_TYPE:-t3.small}"           # 2 vCPU / 2GB — headless Chromium needs >1GB
NAME="bethpage-sniper"
KEY_NAME="${AWS_KEY_NAME:-bethpage-sniper-key}"
KEY_FILE="$HOME/.ssh/${KEY_NAME}.pem"

echo "→ Region: $REGION  AZ: $AZ  Type: $TYPE"

# ── SSH key pair ──────────────────────────────────────────
if aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  if [[ ! -f "$KEY_FILE" ]]; then
    echo "✗ Key pair $KEY_NAME exists in AWS but $KEY_FILE is missing locally."
    echo "  Fix: aws ec2 delete-key-pair --region $REGION --key-name $KEY_NAME  then re-run."
    exit 1
  fi
else
  echo "→ Creating key pair $KEY_NAME → $KEY_FILE"
  aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" \
    --query 'KeyMaterial' --output text > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi

# ── Security group: SSH in (current IP only), all out ─────
SG_NAME="bethpage-sniper-sg"
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  echo "→ Creating security group $SG_NAME"
  SG_ID=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "$SG_NAME" --description "Bethpage sniper - SSH in, all out" \
    --query 'GroupId' --output text)
fi
# Residential IPs move — make sure TODAY'S public IP can SSH (dup rule = no-op).
MYIP=$(curl -s https://checkip.amazonaws.com | tr -d '\n')
if aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
     --protocol tcp --port 22 --cidr "${MYIP}/32" >/dev/null 2>&1; then
  echo "→ SSH ingress added for ${MYIP}/32"
else
  echo "→ SSH ingress already present for ${MYIP}/32"
fi

# ── Find or launch the instance (idempotent via Name tag) ──
IID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=$NAME" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")

if [[ "$IID" == "None" || -z "$IID" ]]; then
  # Latest Ubuntu 22.04 LTS AMI (Canonical's owner ID)
  AMI=$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
              "Name=state,Values=available" \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
  echo "→ Launching $NAME ($TYPE, $AMI) in $AZ"
  IID=$(aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI" --instance-type "$TYPE" \
    --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
    --placement "AvailabilityZone=$AZ" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "   Instance: $IID"
else
  STATE=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" \
    --query 'Reservations[0].Instances[0].State.Name' --output text)
  echo "→ Reusing instance $IID (state: $STATE)"
  if [[ "$STATE" == "stopped" || "$STATE" == "stopping" ]]; then
    aws ec2 wait instance-stopped --region "$REGION" --instance-ids "$IID"
    aws ec2 start-instances --region "$REGION" --instance-ids "$IID" >/dev/null
  fi
fi

aws ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
PUBIP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "   Public IP: $PUBIP"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "$KEY_FILE")
vm() { ssh "${SSH_OPTS[@]}" "ubuntu@$PUBIP" "$@"; }

echo "→ Waiting for SSH..."
until vm 'echo ready' >/dev/null 2>&1; do sleep 5; done

echo "→ Base setup: timezone, Amazon Time Sync (chrony), swap, Node 20, tmux"
vm 'set -e
sudo timedatectl set-timezone America/New_York
sudo apt-get update -q >/dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q chrony tmux rsync >/dev/null
# EC2-local NTP source (169.254.169.123) — sub-ms clock; turbo fires at 19:00:00 sharp
echo "server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4" | \
  sudo tee /etc/chrony/sources.d/aws-time-sync.sources >/dev/null
sudo systemctl enable --now chrony >/dev/null 2>&1
sudo systemctl restart chrony
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
date  # visual confirmation: must print EDT/EST, never UTC
'

echo "→ Syncing project to VM"
vm 'mkdir -p ~/bethpage-sniper/logs'
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  ~/bethpage-sniper/src ~/bethpage-sniper/scripts ~/bethpage-sniper/static \
  ~/bethpage-sniper/package.json ~/bethpage-sniper/package-lock.json \
  ~/bethpage-sniper/tsconfig.json ~/bethpage-sniper/.env ~/bethpage-sniper/auth \
  "ubuntu@$PUBIP:~/bethpage-sniper/"

echo "→ npm ci + Playwright Chromium"
vm 'set -e
cd ~/bethpage-sniper
chmod 600 .env auth/session.json 2>/dev/null || true
grep -q "^HEADLESS=1" .env || echo "HEADLESS=1" >> .env   # no display on a VM
npm ci --no-audit --no-fund
sudo npx playwright install-deps chromium
npx playwright install chromium
'

echo "→ Installing always-on dashboard service (sniper-dashboard)"
vm 'sudo tee /etc/systemd/system/sniper-dashboard.service >/dev/null <<EOF
[Unit]
Description=Bethpage Sniper dashboard
After=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/bethpage-sniper
ExecStart=/usr/bin/npx tsx src/ui-server.ts
Environment=HEADLESS=1
Environment=NO_OPEN=1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable sniper-dashboard >/dev/null 2>&1
sudo systemctl restart sniper-dashboard
echo "   dashboard: $(systemctl is-active sniper-dashboard) (binds 127.0.0.1:4747 — tailnet/ssh-tunnel only)"'

echo ""
echo "→ RTT from VM to foreupsoftware.com (GCP us-west1 ~28ms connect; target 1-5ms):"
vm 'for i in 1 2 3 4 5; do
  curl -o /dev/null -s -w "  connect=%{time_connect}s  ttfb=%{time_starttransfer}s\n" \
    https://foreupsoftware.com/index.php/booking/19765/2431
done'

echo ""
echo "✓ VM ready in AWS us-west-2.  Instance: $IID  IP: $PUBIP"
echo ""
echo "  Systems check:  ssh -i $KEY_FILE ubuntu@$PUBIP 'cd ~/bethpage-sniper && npm run turbo:dry'"
echo "  Sunday (auto):  ssh -i $KEY_FILE -t ubuntu@$PUBIP 'cd ~/bethpage-sniper && tmux new -A -s snipe \"AUTO_BOOK=1 npx tsx src/turbo.ts --race\"'"
echo "  Dashboard:      ssh -i $KEY_FILE -L 4747:localhost:4747 ubuntu@$PUBIP  → http://localhost:4747 on the Mac"
echo "  Stop (save \$):  aws ec2 stop-instances --region $REGION --instance-ids $IID"
echo "                  (IP changes on restart — just re-run this script)"
echo ""
echo "  ⚠ ONE MACHINE PER DROP — if this box races, the GCP VM + Mac must not."
