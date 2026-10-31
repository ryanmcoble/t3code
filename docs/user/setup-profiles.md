# Share MCP connections and skills

Use **Settings → Environments → Setup profiles** to share selected MCP connections and skills between machines. Each environment keeps its own provider accounts and sign-ins.

Create a profile on the environment that will own it. Import MCP connections from a configured harness and enter the skill folders you want to include. A skill includes its companion files, scripts and assets. Review the draft, remove anything you do not want to share, and publish it. Importing and publishing do not change other environments.

Each environment uses one active profile. Detach it before choosing another. Select the local harnesses, then choose **Apply once** for a snapshot or **Apply and sync** for future revisions. On another connected environment, choose the owner and profile to subscribe. You need permission to manage setup on the destination and create subscription access on the owner. The destination server needs a reachable HTTPS address for the owner; a client-only SSH tunnel is insufficient. New environment connections can offer this step after pairing.

Subscribed servers check for revisions independently of the client window. Closing a window does not stop sync while its server stays running. A stopped server catches up after it restarts. Owner outages retain the last applied setup. Pause stops revision updates while keeping the current setup; detach stops the subscription. Removing managed setup preserves edited local files and explicit local overrides.

Credential values are not included in imports or subscriptions. Imported environment variables and headers become named secret references. Bind them separately on each destination when the receipt says **Needs secret**. Native OAuth, legacy SSE, dynamic header helpers and restricted native tool filters require supported native configuration; unsupported imports are reported. Provider login sessions are not copied.

Profiles make MCP connections available in T3-managed native sessions. Skills use each supported harness's native skill directory, which can also make them available to its standalone CLI. Claude, Codex, managed OpenCode and Copilot have native adapters; other configurations report their supported subset. Externally managed OpenCode servers are not modified. **Configured** means setup has been installed or injected; it does not prove a model has invoked it. Missing executables and unresolved secrets remain visible in the receipt. Changes activate between runs without interrupting native background work.

Local edits are conflicts, not permission to overwrite a file. Choose **Keep local** for an override or **Use profile** to replace it. A profile owns only its recorded files. Existing unowned skills require an explicit choice before T3 takes ownership.

## Inspect or recover a profile

Read readiness from the environment's CLI:

```sh
t3 setup status
```

Agents can read the same credential-free readiness through `t3_environment_read`. This grants no profile publishing or installation authority.

Back up a profile and its complete skill packages into a new directory:

```sh
t3 setup export <profile-id> <new-directory>
```

With the destination server stopped, restore it as a new owned profile:

```sh
t3 setup restore <backup-directory>
```

The restored profile has a new identity. Select it and enroll environments again; credentials and subscriptions are excluded from the backup. Use `--base-dir` for a separate T3 installation.
