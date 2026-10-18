# Installing Roblox Bridge on Windows 10

This guide covers setting up `roblox-bridge` to drive Roblox Studio from your local command line, and optionally opening it securely to the internet with Cloudflare Tunnels (so AI assistants or remote scripts can execute commands).

## 1. Prerequisites

1. **Node.js 18+**: Download from [nodejs.org](https://nodejs.org/) or install via winget:
   ```powershell
   winget install OpenJS.NodeJS
   ```
2. **Roblox Studio**: Installed and logged in.

## 2. Unpack the Archive

Extract `roblox-bridge.zip` to a permanent location, such as `C:\roblox-bridge`.

Open PowerShell and navigate to the directory:
```powershell
cd C:\roblox-bridge
```

*(No `npm install` is required for production usage, as it has zero external dependencies!)*

## 3. Install the Local Plugin

Roblox Studio loads local plugins from a specific AppData folder.

1. Open PowerShell and copy the built plugin into the Roblox plugins folder:
   ```powershell
   $PluginsDir = "$env:LOCALAPPDATA\Roblox\Plugins"
   if (!(Test-Path $PluginsDir)) { New-Item -ItemType Directory -Force -Path $PluginsDir }
   Copy-Item .\plugin\roblox-bridge.rbxmx -Destination $PluginsDir\
   ```
2. Restart Roblox Studio.
3. Enable HTTP Requests for your place:
   - In Studio, go to **Home** → **Game Settings** → **Security**.
   - Toggle **Allow HTTP Requests** to **ON**.
   - Click **Save**.

## 4. Basic Local Setup (No Tunnel)

If you only want to use the CLI on the same machine, start the bridge server in one terminal:
```powershell
npm start
```
The server will bind to `127.0.0.1:8787` by default.

### Connect the Plugin
1. Open your place in Studio.
2. In the **Plugins** tab, click **Connect** in the Roblox Bridge toolbar.
3. The plugin will connect to the bridge.

### Run Commands
In a new PowerShell window in the `roblox-bridge` folder, you can run Luau code:
```powershell
node cli/cli.js ping
node cli/cli.js exec 'print("Hello from CLI!")'
```

---

## 5. Exposing Over the Internet (Cloudflare Tunnel)

To allow an AI assistant or a remote CI server to control Studio, you must use a tunnel and **enable token protection**. Without a token, anyone on the internet could execute arbitrary Luau code in your Studio session.

### Generate a Token
```powershell
node cli/cli.js token
```
Copy the output (e.g., `aBC123XYZ...`).

### Start the Protected Bridge
```powershell
$env:ROBLOX_BRIDGE_REQUIRE_TOKEN = "true"
$env:ROBLOX_BRIDGE_TOKEN = "YOUR_GENERATED_TOKEN"
npm start
```
*(The bridge will now reject any request that doesn't include the token).*

### Configure the Plugin
1. In Studio, click the **Settings** button in the Roblox Bridge toolbar.
2. In the **Bridge URL** box, keep `http://127.0.0.1:8787`.
3. In the **Token (optional)** box, paste your generated token.
4. Click **Save** and then click **Connect**.

### Set Up the Cloudflare Tunnel

1. Install `cloudflared` using winget:
   ```powershell
   winget install --id Cloudflare.cloudflared
   ```
2. Close and reopen PowerShell so the `cloudflared` command is available.
3. Start a Quick Tunnel pointing to the bridge:
   ```powershell
   cloudflared tunnel --url http://127.0.0.1:8787
   ```
4. Look for the `trycloudflare.com` URL in the output. This is your public tunnel URL.

### Test the Protected Tunnel

Now, you (or your AI) can execute commands remotely by providing the URL and Token:

```powershell
node cli/cli.js ping --url https://your-tunnel.trycloudflare.com --token YOUR_GENERATED_TOKEN
```

If you omit `--token`, the server will reject it with a 401 Unauthorized, protecting your Studio instance.
