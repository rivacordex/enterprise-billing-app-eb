# Enterprise Billing — Azure Network (hub-spoke) + P2S VPN

Manual setup and operations guide for the **network foundation** and the
**point-to-site (P2S) VPN Gateway** that fronts it.

> **No secrets in this document.** It contains no keys, passwords, certificate
> private material, or connection strings. Where credentials/certs are needed,
> it points at the command that generates them locally — the private material
> never leaves your machine and must never be committed.

This covers **networking only**. The Postgres Flexible Server and the Container
Apps (App + Kestra) are **out of scope here** — their subnets are created and
pre-delegated so those workloads drop in later.

---

## Contents

- [Topology](#topology)
- [Address plan](#address-plan)
- [Prerequisites (once)](#prerequisites-once)
- [Part A — VNet / network foundation](#part-a--vnet--network-foundation) ← cheap, stays up
- [Part B — VPN Gateway: first-time setup](#part-b--vpn-gateway-first-time-setup) ← the paid, on-demand piece
- [Part C — VPN Gateway: day-to-day operations (bring up / down)](#part-c--vpn-gateway-day-to-day-operations)
- [Cost summary](#cost-summary)
- [Files in this folder](#files-in-this-folder)

---

## Topology

```
                Azure VPN Client (your PC)
                          │  P2S tunnel (OpenVPN/IKEv2, cert auth)
                          │  client pool 172.16.0.0/24
                          ▼
   ┌───────────────────────────────────────────────┐
   │  HUB VNet  "Private Network"   10.10.0.0/24     │
   │  ┌──────────────────────────┐                   │
   │  │ GatewaySubnet 10.10.0.0/27│  ← VPN Gateway    │
   │  └──────────────────────────┘     (VpnGw1AZ)      │
   └───────────────────────────────────────────────┘
                          │  VNet peering (gateway transit)
                          ▼
   ┌───────────────────────────────────────────────┐
   │  BILLING VNet  "spoke"        10.20.0.0/26      │
   │  ┌───────────────────────┐ ┌──────────────────┐ │
   │  │ snet-billing-aca      │ │ snet-billing-    │ │
   │  │ 10.20.0.0/27          │ │ postgres         │ │
   │  │ → App FE / Kestra FE  │ │ 10.20.0.32/28    │ │
   │  │   (ACA, :443)         │ │ → Postgres :5432 │ │
   │  └───────────────────────┘ └──────────────────┘ │
   │   NSG: allow VPN pool→443   NSG: allow VPN→5432  │
   └───────────────────────────────────────────────┘
```

The Billing VNet "sits within" the Private Network by being **peered into it**
(Azure VNets can't literally nest). Once the gateway is up and peering uses
gateway transit, a device on the P2S tunnel reaches the spoke over private IPs.

**A note on "ports":** Azure Container Apps HTTP ingress always terminates on
**443**, per app **hostname** — you don't get "443 for the app, 3000 for
Kestra." Both the App FE and the Kestra FE are reached on **443** at their own
private FQDNs; `3000`/`8080` are only the internal container ports. Postgres is a
genuine raw **5432**. The NSG rules encode exactly that.

---

## Address plan

| Network | Range | Purpose |
|---|---|---|
| Hub VNet (Private Network) | `10.10.0.0/24` | Holds the VPN Gateway; room for a future bastion/jumpbox |
| ↳ `GatewaySubnet` | `10.10.0.0/27` | Reserved for the VPN Gateway (name fixed by Azure) |
| Billing VNet (spoke) | `10.20.0.0/26` | Workloads, peered into the hub |
| ↳ `snet-billing-aca` | `10.20.0.0/27` | ACA environment (delegated `Microsoft.App/environments`) |
| ↳ `snet-billing-postgres` | `10.20.0.32/28` | Postgres Flexible Server (delegated `Microsoft.DBforPostgreSQL/flexibleServers`) |
| ↳ spare | `10.20.0.48/28` | Headroom |
| P2S VPN client pool | `172.16.0.0/24` | Addresses handed to VPN clients (off-VNet, non-overlapping) |

All three ranges are non-overlapping — required for peering and P2S routing.
Change them in `parameters/network.dev.bicepparam` (and the matching values in
`parameters/vpn-gateway.dev.bicepparam`) if they collide with a corporate range.

---

## Prerequisites (once)

```powershell
# Azure CLI + Bicep
az version
az bicep version            # if missing: az bicep install

# Sign in and select the subscription
az login
az account set --subscription "<subscription-id>"

# This network build only needs the Network provider (already registered on this sub).
az provider show -n Microsoft.Network --query registrationState -o tsv   # → Registered
```

- **Resource group:** `<resource-group>` (region `australiaeast`) already exists. Adjust the
  commands below if you target a different RG/region.
- **Permissions:** you need at least **Network Contributor** on the resource
  group (Contributor/Owner also work).
- The `Microsoft.App` and `Microsoft.DBforPostgreSQL` providers are **not**
  needed for this pass — register them later when the workloads land.

Set these once per shell so the commands below are copy-paste:

```powershell
$RG  = "<resource-group>"
$LOC = "australiaeast"
```

---

## Part A — VNet / network foundation

> Cheap (~free for empty VNets/NSGs). Deploy once and leave up. Idempotent —
> safe to re-run.

### A1. Validate the templates (no cost, no changes)

```powershell
az bicep build --file infra/bicep/network/network.bicep
az bicep build --file infra/bicep/network/vpn-gateway.bicep
```

### A2. Preview what will be created (what-if)

```powershell
az deployment group what-if --resource-group $RG `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam
```

### A3. Deploy the network foundation

```powershell
az deployment group create --resource-group $RG --name ebill-network-dev `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam
```

Creates: `ebill-dev-hub-vnet`, `ebill-dev-billing-vnet`, the subnets (with
delegations), `ebill-dev-aca-nsg`, `ebill-dev-postgres-nsg`, and both peerings.
Leave `hubGatewayDeployed = false` for now (Part B flips it).

### A4. Verify

```powershell
az network vnet list -g $RG -o table
az network vnet subnet list -g $RG --vnet-name ebill-dev-billing-vnet -o table
az network vnet peering list -g $RG --vnet-name ebill-dev-billing-vnet -o table
```

Peering state should read `Connected`. **Part A is complete** — the network is
ready and the App/Kestra/Postgres subnets are waiting for their workloads.

---

## Part B — VPN Gateway: first-time setup

> **This is the paid, slow, on-demand piece.** VpnGw1AZ ≈ **~$154/mo** and cannot
> be paused (see [Cost summary](#cost-summary)). Provisioning takes **~30–45
> minutes**. Do this when you actually want to connect; use
> [Part C](#part-c--vpn-gateway-day-to-day-operations) to bring it down when done.

### B1. Generate P2S certificates (local — private keys never leave your PC)

On **Windows / PowerShell**, create a self-signed **root** cert and a **client**
cert signed by it. The private keys stay in your user certificate store; you only
ever upload the root's **public** data. **Do this BEFORE deploying the gateway**
— Azure now requires the root cert to be present at creation time.

```powershell
# Root cert (stays in Cert:\CurrentUser\My)
$root = New-SelfSignedCertificate -Type Custom -KeySpec Signature `
  -Subject "CN=ebill-p2s-root" -KeyExportPolicy Exportable `
  -HashAlgorithm sha256 -KeyLength 2048 `
  -CertStoreLocation "Cert:\CurrentUser\My" -KeyUsageProperty Sign -KeyUsage CertSign

# Client cert signed by the root (this is what authenticates your device)
New-SelfSignedCertificate -Type Custom -KeySpec Signature `
  -Subject "CN=ebill-p2s-client" -KeyExportPolicy Exportable `
  -HashAlgorithm sha256 -KeyLength 2048 `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -Signer $root -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.2")

# Export ONLY the root's public data (base64). This is a PUBLIC key — not a secret.
$rootPublic = [Convert]::ToBase64String($root.Export('Cert'))
$rootPublic | Out-File "$env:USERPROFILE\ebill-p2s-root-public.txt" -Encoding ascii
```

> ⚠️ Never export or commit the `.pfx`/private keys. Only the base64 **public**
> string from `ebill-p2s-root-public.txt` is uploaded, and even that is not kept
> in this repo.

### B2. Deploy the gateway (passing root cert at creation)

Azure requires the root cert at creation when certificate auth is selected.
Pass it via `--parameters` override — never commit it to the param file.

```powershell
$rootPublic = (Get-Content "$env:USERPROFILE\ebill-p2s-root-public.txt" -Raw).Trim()

az deployment group create --resource-group $RG --name ebill-vpngw-dev `
  --template-file infra/bicep/network/vpn-gateway.bicep `
  --parameters infra/bicep/network/parameters/vpn-gateway.dev.bicepparam `
  --parameters rootCertData=$rootPublic
```

☕ ~30–45 min. Creates `ebill-dev-vpngw-pip` (static public IP) and
`ebill-dev-vpngw` (the gateway) with P2S configured and the root cert active.

### B3. Enable gateway transit into the spoke

Now that the gateway exists, let P2S clients route into the Billing spoke:

```powershell
# Re-deploy the network template with the toggle ON (declarative source of truth)
az deployment group create --resource-group $RG --name ebill-network-dev `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam `
  --parameters hubGatewayDeployed=true
```

> (Quick equivalent, if you prefer not to re-run the template:
> `az network vnet peering update -g $RG --vnet-name ebill-dev-billing-vnet -n billing-to-hub --set useRemoteGateways=true`.
> The template with `hubGatewayDeployed=true` remains the source of truth — keep
> `parameters/network.dev.bicepparam` in sync if you flip it by hand.)

### B4. Download the VPN client profile and connect

```powershell
# Generate the client profile package (returns a URL to a .zip)
az network vnet-gateway vpn-client generate --resource-group $RG `
  --name ebill-dev-vpngw --authentication-method EAPTLS
```

1. Download and unzip the package from the returned URL.
2. Install the **Azure VPN Client** (Microsoft Store) if you don't have it.
3. In Azure VPN Client → **Import** → select the `AzureVPN/azurevpnconfig.xml`
   from the unzipped package → **Connect**.
4. Verify you have a `172.16.0.0/24` address and can reach the spoke (once the
   App/Kestra/Postgres workloads exist, e.g. `https://<app-fqdn>` on 443,
   `psql -h <postgres-fqdn>` on 5432).

**VPN is live.** When you're done using it, go to
[Part C](#part-c--vpn-gateway-day-to-day-operations) to stop the cost.

---

## Part C — VPN Gateway: day-to-day operations

The gateway can't be paused, so "off" means **deleted**. The network foundation
(Part A) and the public IP stay in place, so bring-up/down is quick to drive.

### Check status / whether it's currently up

```powershell
# Exists + provisioning state (errors "ResourceNotFound" when it's been brought down)
az network vnet-gateway show -g $RG -n ebill-dev-vpngw `
  --query "{name:name, state:provisioningState, sku:sku.name}" -o table

# Is a client currently connected?
az network vnet-gateway list-connections -g $RG -n ebill-dev-vpngw -o table 2>$null
```

### 🔻 Bring DOWN (stop the ~$154/mo charge)

```powershell
# 1. (Optional) Disconnect the Azure VPN Client on your PC first.

# 2. Detach gateway transit so the spoke peering isn't left pointing at a
#    gateway that's about to disappear.
az deployment group create --resource-group $RG --name ebill-network-dev `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam `
  --parameters hubGatewayDeployed=false

# 3. Delete the gateway (a few minutes). This is what stops the billing.
az network vnet-gateway delete -g $RG -n ebill-dev-vpngw

# 4. Verify it's gone.
az network vnet-gateway show -g $RG -n ebill-dev-vpngw -o table   # → ResourceNotFound = down
```

The public IP `ebill-dev-vpngw-pip` is intentionally **kept** (tiny cost, stable
address). To also drop it: `az network public-ip delete -g $RG -n ebill-dev-vpngw-pip`.

### 🔺 Bring UP (recreate on demand)

```powershell
# 1. Recreate the gateway with root cert (~30–45 min). Re-uses the existing public IP by name.
$rootPublic = (Get-Content "$env:USERPROFILE\ebill-p2s-root-public.txt" -Raw).Trim()
az deployment group create --resource-group $RG --name ebill-vpngw-dev `
  --template-file infra/bicep/network/vpn-gateway.bicep `
  --parameters infra/bicep/network/parameters/vpn-gateway.dev.bicepparam `
  --parameters rootCertData=$rootPublic

# 2. Re-enable gateway transit.
az deployment group create --resource-group $RG --name ebill-network-dev `
  --template-file infra/bicep/network/network.bicep `
  --parameters infra/bicep/network/parameters/network.dev.bicepparam `
  --parameters hubGatewayDeployed=true

# 3. Re-download the client profile (B4) and reconnect.
```

> **Why re-download the profile each time?** Deleting the gateway wipes its P2S
> state (generated client profiles). The VNets, NSGs, peering, and public IP
> survive — and the root cert is now baked in at deploy time — so only the profile
> download step repeats. Keep `ebill-p2s-root-public.txt` on your machine.

### Optional: script it

Wrap **Bring UP** / **Bring DOWN** in two small `.ps1` scripts so a session is
one command. Keep the root-cert public string in a local file (as above), not in
git.

---

## Cost summary

| Resource | Cost | Pausable? |
|---|---|---|
| VNets, subnets, NSGs, peering (Part A) | ~free | n/a — leave up |
| **VPN Gateway `VpnGw1AZ`** | **~$154/mo while it exists** | ❌ delete/recreate only (~30–45 min) |
| Gateway public IP (Standard, static) | ~$3–4/mo | kept between up/down cycles |
| P2S data transfer | per-GB egress | — |

**The gateway is the only expensive, un-pausable piece.** Bring it down (Part C)
whenever you're not connecting. If you connect *very* frequently and the idle
cost stings, a self-hosted VPN on a **deallocatable VM** is the cheaper-when-idle
alternative discussed previously — not built here.

---

## Files in this folder

| File | What it is |
|---|---|
| `network.bicep` | Hub + spoke VNets, subnets (delegated), NSGs, peering. The `hubGatewayDeployed` param toggles gateway transit. |
| `vpn-gateway.bicep` | The P2S VPN Gateway + its public IP. Deploy/delete independently. |
| `parameters/network.dev.bicepparam` | Dev values for the network (address plan, target env). |
| `parameters/vpn-gateway.dev.bicepparam` | Dev values for the gateway (SKU, client pool; **no cert data**). |
| `README.md` | This guide. |

**Not here (by design):** Postgres Flexible Server, Container Apps environment/
apps, Key Vault, and any secret/cert/password material.
