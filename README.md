# CloudIPA ☁️📱

> **Cross-Platform Remote iOS Build Engine**  
> Compile native iOS, Flutter, and React Native Xcode projects into unsigned `.ipa` packages using GitHub-hosted macOS runners—**without owning a Mac or installing Xcode locally**.

---

## 🌟 Key Highlights

- **Zero Local Mac / Xcode Dependency:** Run seamlessly on Windows, Linux, and macOS. All local project detection and metadata extraction are executed via pure Node.js filesystem traversal and regex parsing.
- **Automated Cloud Compilation:** Leverages GitHub Actions macOS runners (`macos-15`, `macos-14`) via the GitHub CLI (`gh`).
- **Deterministic Run Correlation:** Generates unique request UUIDs to track and monitor your specific build across GitHub Actions runs.
- **Polite Polling & Anti-Ban Safeguards:** Enforces a minimum 10-second polling interval with backoff and jitter, preventing GitHub API secondary rate limits.
- **Hard 25-Minute Timeout & Concurrency Controls:** Eliminates the risk of runaway macOS runner processes or triggering automated abuse/cryptomining heuristics.
- **Cryptographic & Structure Validation:** Inspects and validates downloaded `.ipa` ZIP archives (`Payload/*.app/Info.plist`) and checks SHA-256 integrity.

---

## 🏗️ Architecture

```text
[ Windows / Linux Developer Machine ]
  ├── 1. cloudipa doctor      → 8-Point Environment Diagnostics
  ├── 2. cloudipa init        → Generates .cloudipa.yml & .github/workflows/cloudipa-build.yml
  └── 3. cloudipa build       → Pure Node.js Project Detection
                              → Local Git Sync Verification
                              → Dispatches GitHub Workflow with Request UUID
                              │
                              ▼ (via GitHub CLI 'gh')
[ GitHub Actions Cloud (macOS Runner) ]
  ├── Checkouts repository
  ├── Selects Xcode version (auto or specified)
  ├── Compiles unsigned .app with CODE_SIGNING_ALLOWED=NO
  ├── Packages into standard Payload/ archive (.ipa)
  ├── Extracts Info.plist metadata & calculates SHA-256
  └── Uploads cloudipa-artifact-<request_id>
                              │
                              ▼ (download & stream)
[ Local Machine Completion ]
  ├── Downloads .ipa to ./build/
  ├── Verifies SHA-256 checksum
  └── Validates ZIP central directory (Payload/*.app/Info.plist)
```

---

## 📋 Prerequisites

Before using CloudIPA, ensure the following are installed on your system:

1. **Node.js (>= 18.0.0)**: Check with `node -v`
2. **Git**: Check with `git --version`
3. **GitHub CLI (`gh`)**: Check with `gh --version`
   - *Windows:* `winget install GitHub.cli` or `choco install gh`
   - *Linux:* `sudo apt install gh` or your distribution package manager
   - *macOS:* `brew install gh`
4. **Authenticate GitHub CLI:**
   ```bash
   gh auth login
   ```

To verify your environment instantly, run:
```bash
cloudipa doctor
```

---

## 🚀 Quick Start

### 1. Installation
Install globally or run via npx:
```bash
npm install -g cloudipa
```
Or clone and build from source:
```bash
git clone https://github.com/your-username/cloudipa.git
cd cloudipa
npm install
npm run build
npm link
```

### 2. Initialize your iOS Repository
Inside your iOS or cross-platform repository root:
```bash
cloudipa init
```
This inspects your local `.xcodeproj` or `.xcworkspace`, generates `.cloudipa.yml`, installs `.github/workflows/cloudipa-build.yml`, and updates `.gitignore`.

Push the generated workflow to GitHub:
```bash
git add .cloudipa.yml .github/workflows/cloudipa-build.yml .gitignore
git commit -m "ci: configure CloudIPA remote build workflow"
git push origin main
```

### 3. Build Your Unsigned IPA
```bash
cloudipa build
```

CloudIPA will display a 7-stage interactive progress tracker:
```text
[1/7] Environment & Auth Validation
[2/7] Local Project & Git Inspection
[3/7] Remote Workflow Dispatch
[4/7] Queued / Runner Allocation
[5/7] Remote macOS Build Execution
[6/7] Artifact Download & Checksum Verification
[7/7] Local IPA Archive Integrity Validation
```

The resulting package is placed in `./build/MyApp.unsigned.ipa`.

---

## 🛠️ CLI Reference

### `cloudipa doctor`
Runs an 8-point diagnostic check:
- Node.js runtime version
- Git CLI availability
- GitHub CLI (`gh`) availability
- GitHub authentication status
- Local Git repository status
- Remote origin configuration
- CloudIPA GitHub workflow presence
- Remote repository read/write access

### `cloudipa init`
Generates `.cloudipa.yml` and installs `.github/workflows/cloudipa-build.yml`.

### `cloudipa build [path]`
Triggers remote cloud compilation.
| Option | Description | Default |
| --- | --- | --- |
| `-s, --scheme <scheme>` | Xcode scheme to compile | Auto-detected |
| `-c, --configuration <config>` | `Release` or `Debug` | `Release` |
| `-r, --runner <runner>` | macOS runner label (`macos-15`, `macos-14`) | `macos-15` |
| `-o, --output <path>` | Destination directory or `.ipa` path | `./build` |
| `--ref <branch>` | Git branch or ref to compile on remote | Current branch |
| `--xcode <version>` | Xcode version to select (`16.0`, `15.4`, `auto`) | `auto` |
| `-t, --timeout <minutes>`| Maximum build execution timeout | `25` |
| `--allow-dirty-remote` | Allow remote build even if local tree has uncommitted/unpushed edits | `false` |
| `--no-wait` | Dispatch workflow and exit without waiting | `false` |
| `--plain` | Disable ANSI formatting and color output | `false` |
| `--verbose` | Enable debug logging | `false` |

### `cloudipa status`
Inspects `.cloudipa/last-build.json` and fetches live status from GitHub Actions.

### `cloudipa logs [runId]`
Streams the raw build execution logs from GitHub Actions.

### `cloudipa download [runId]`
Downloads the artifact from the latest or specified workflow run and validates its ZIP integrity.

---

## ⚙️ Configuration Reference (`.cloudipa.yml`)

```yaml
project:
  path: .
  workspace: ""              # Optional relative path to .xcworkspace
  project: "MyApp.xcodeproj" # Optional relative path to .xcodeproj
  scheme: MyApp              # Xcode scheme to compile
  configuration: Release     # Release or Debug

github:
  workflow: cloudipa-build.yml
  branch: main

build:
  runner: macos-15           # macos-15 (Apple Silicon M1/M2) or macos-14
  xcode_version: auto        # auto, 16.0, 15.4
  signing: disabled
  destination: generic/platform=iOS
  timeout_minutes: 25        # Hard safety timeout

output:
  directory: ./build
  filename: MyApp.unsigned.ipa
```

---

## 💳 GitHub Actions Billing & Minute Multipliers

> [!IMPORTANT]
> **macOS Runner Minute Multiplier Notice**  
> GitHub Actions pricing applies a **10x minute multiplier** for macOS runners (`macos-14`, `macos-15`) on billable private repositories:
> - 1 minute of macOS runner time = **10 included minutes** (or \$0.08/minute).
> - Public repositories on GitHub receive free GitHub Actions runner minutes (subject to GitHub Fair Use).
> - CloudIPA enforces `timeout-minutes: 25` to protect your billing allocation and prevent runaway builds.

---

## 📲 Sideloading & Installing Unsigned IPAs

> [!WARNING]
> **Stock iOS Code Signing Notice**  
> iOS requires all applications to carry a cryptographically valid code signature and provisioning profile before executing on a physical device.  
> 
> CloudIPA produces **unsigned `.ipa` packages** (`CODE_SIGNING_ALLOWED=NO`). You **cannot** install an unsigned IPA directly using stock AirDrop or iTunes.

To install the resulting `.ipa` on your iPhone or iPad:

1. **AltStore / SideStore:** (Free 7-day personal certificate using your Apple ID)
   - Open AltServer on PC/Mac or SideStore on your device.
   - Select the downloaded `.unsigned.ipa` file to sign and install it.
2. **Sideloadly:** (Windows & macOS sideloading utility)
   - Connect your iOS device via USB/Wi-Fi.
   - Drag and drop your `.unsigned.ipa` into Sideloadly and enter your Apple ID.
3. **Feather / Scarlet / ESign:**
   - On-device sideloading managers using custom distribution certificates.
4. **TrollStore:** (iOS 14.0 - 16.6.1 / 17.0 on supported devices)
   - Installs unsigned IPAs directly with elevated entitlements (CoreTrust exploit).
5. **Apple Developer Account (Ad-Hoc / TestFlight):**
   - Resign the IPA using `zsign`, `fastlane sigh resign`, or `codesign` with your registered provisioning profile.

---

## 🔒 GitHub Anti-Ban & Fair Use Compliance

CloudIPA is engineered for strict compliance with GitHub's Terms of Service:
- **No Local Xcode Abuse:** Zero emulation or spoofing.
- **Zero Hidden Tunnels:** No reverse SSH tunnels (`tmate`, `ngrok`), background daemons, or obfuscated payloads.
- **Concurrency Limiting:** `concurrency` blocks prevent runner queue flooding.
- **Polite Polling:** 10-second polling cadence with jitter prevents Secondary Rate Limit triggers.
- **Least Privilege:** Workflow permissions are restricted strictly to `contents: read`.

---

## 🧪 Testing

CloudIPA comes with a comprehensive Vitest test suite running deterministic offline mocks:
```bash
npm test
```
To run tests with watch mode:
```bash
npm run test:watch
```

---

## 📄 License
MIT © CloudIPA Authors
