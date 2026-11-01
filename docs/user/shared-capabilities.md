# Share memory and desktop tools

Use **Settings → Environments** to manage shared memory and computer use for each connected machine. The mobile app exposes the same controls under the environment's settings.

## Shared memory

Create a personal, company or project scope. Choose the local projects and provider instances that may read it, and whether those instances may add or correct findings. An empty selection grants no agent access. Personal and company accounts remain separate instances, even when they use the same harness.

Save decisions, preferences and verified findings with a source or reason. Agents discover their allowed scopes with `t3_memory_scopes`, retrieve bounded context with `t3_memory_search`, and save findings with `t3_memory_remember`. Notes are evidence; they do not grant permission or replace the user's instructions.

Use **Correct** to supersede a finding. Retrieval excludes the old version while export retains its history and attribution. Delete removes a finding's content from retrieval and export. **Delete scope and history** removes the scope's full history and access grants.

To share a scope, select its owning environment, then select the destination's projects and harness instances. The owner needs a reachable HTTPS route. The destination receives a scope-specific read or write credential; it does not receive the owner's provider logins. Reads and corrections go to the owner. If it is unavailable, T3 reports that condition instead of silently returning a stale copy.

A setup profile may advertise memory owner/scope references and access policy. Connecting one still requires destination project mapping and authorization on both environments. Memory content is separate from profile revisions. Export from the owning environment when you need a copy of the scope and its history.

## Computer use

Install and start [Cua Driver](https://cua.ai/docs/cua-driver/quickstart) 0.38 or newer in the desktop session on each environment you want agents to operate. It is a separate prerequisite; T3 does not install Cua Spaces or copy OS permissions. On macOS, enable Cua Driver's Accessibility and Screen Recording permissions. T3's permission checks do not open those prompts.

Enable computer use, select the harness instances, and enter the allowed app identifiers. On macOS these are bundle IDs such as `com.apple.calculator`. A local executable override is available when the driver is outside the server's PATH. Desktop policy may come from the applied setup profile; an explicit local configuration takes precedence until you select **Use profile desktop policy**.

In a full-access/default thread, agents use `t3_computer_apps`, acquire an app lease with `t3_computer_control`, and inspect a window with `t3_computer_observe`. Observation returns accessibility information and an image. Input is limited to that thread's leased app. The agent should observe after acting and release the desktop when finished.

Each lease binds an exact app process and window. One T3 thread controls an environment's desktop at a time. The lease expires after two idle minutes. Settings show its owner and provide **Release desktop**, including from mobile. Release cancels a pending driver request and prevents further calls with that lease. Direct Cua clients outside T3 do not participate in this coordination.

Driver availability, OS grants and a working desktop capture are distinct checks. A successful permission report does not prove a particular window can be captured; the first observation verifies that. Missing apps, permissions, an unavailable graphical session or a stale lease produce an error rather than selecting another desktop.
