# Share memory and desktop tools

Use **Settings → Environments → Environment setup** to choose a machine, then open **Memory** or **Computer use**. The mobile app exposes the same controls under the environment's settings.

## Containers

Open **Settings → Environments → Containers** to inspect Docker on a selected machine. A thread's **Containers** section shows containers linked to its project or worktree. Search and filter the inventory, expand a container for its ports and measurements, or request recent logs. Collection stops when the view is closed or backgrounded; cached and partial results are labeled.

T3 uses Compose paths and bind mounts to suggest folder links. You can include or exclude a container explicitly, or link a Compose stack when its configuration files establish its identity. Saved stack links survive container replacement. Remove obsolete links under saved folder rules. These links describe relationships; they do not grant cleanup ownership or change Docker resources. Only local Docker engines are supported. Agents with diagnostics access can inspect the same inventory and bounded logs through `t3_containers`.

Ask an agent to provision a T3-managed disposable container when you want lifecycle controls. Creation requires an installed image without declared volumes; it does not pull images. Published ports bind only to loopback. **Managed resources** shows ownership receipts and start, stop, retain, recovery and release actions on desktop and mobile. Retention blocks release, and shared references protect other threads. Release removes the owned container while preserving mounted workspace files and Docker volumes. Existing unowned containers cannot be adopted or released through these controls.

## Shared memory

Create a personal, company, project, or temporary category. Select its provider instances and the projects, folder roots, or repositories where it applies. Folder rules include nested folders by default, so a company category can cover new repositories created beneath its company directory. Add exclusions where needed. Repository rules also recognize Git worktrees of the selected checkout. Paths belong to the selected environment, including when you configure them from the phone. An empty selection grants no access unless you explicitly select all projects.

Enable **Search applicable categories before each prompt** to have T3 retrieve relevant memories before an ordinary agent turn. Pinned preferences and matching findings share a token budget. The thread's memory controls show the matched categories, why they apply, and the entries recalled. Already delivered entries are reused within a native session; new sessions and observed compactions restore them. Retrieved notes are supporting evidence, not permission or a replacement for your current instructions.

Save a finding with a source or reason, or start a message with **Remember that …** or **Remember this: …**. Explicit remember requests use an unambiguous writable category without an extraction-model call. When several categories could receive the memory, choose the category in settings or ask the agent to use the appropriate scope. Agents can search and save through T3's memory tools and use `t3_memory_forget` when you ask to remove an entry. Planning mode cannot change memories.

Automatic learning is separate from recall. Choose manual saves, suggestions for review, or automatic saving of supported preferences. Configure an installed local Ollama generation model, learning guidance, and a daily token limit on the environment doing the work. Extraction runs after completed work, uses only new user messages, and disables reasoning. Each attempt reserves 8,704 tokens against the daily limit; no cloud provider or paid fallback is selected. Failed or interrupted attempts are not automatically repeated. Suggestions retain a supporting quote and remain searchable only after acceptance; conflicting preferences require review. Large reports, native memory folders, and historical chats are not imported automatically.

Use the thread's independent recall and learning switches for temporary work. Disabling learning cancels its pending capture jobs. These controls apply to T3-routed work; independently launched native CLI/Desktop sessions need a separate integration. Turning off recall or deleting a memory stops future retrieval but cannot remove content already delivered in a conversation; start a new thread when you need a fresh context.

Use **Correct** to supersede a finding. Retrieval excludes the old version while export retains its history and attribution. An optional expiry excludes an entry from future recall. Delete removes its content from retrieval and export. **Delete scope and history** removes the scope's full history and access grants.

To share a category, select its owning environment, then select the destination's location rules and harness instances. The owner needs a reachable HTTPS route. Different machines can bind different paths to the same category. The destination receives a scope-specific read or write credential; it does not receive the owner's provider logins. Reads, corrections, and forgetting go to the owner. If it is unavailable, T3 reports that condition instead of silently returning a stale copy.

A setup profile may advertise memory owner/scope references and access policy. Connecting one still requires destination mapping and authorization on both environments. Memory content is separate from profile revisions. Export from the owning environment when you need a copy of the category and its history. Baseline import of existing documentation remains a separate reviewed step after qualification.

## Computer use

Check setup before enabling access. T3 reports driver availability, Accessibility and Screen Recording separately; available permissions do not prove an app can be captured. **Set up with Calculator** prepares a narrow starting policy for your enabled harnesses. Ask an agent to observe Calculator and perform a harmless action to verify the full path.

Choose applications by name from the searchable application list. **Selected applications** limits access to the checked apps; **All applications** permits every app on that environment. Advanced wildcard rules allow an app-identifier prefix, for example `com.apple.*`. Broad rules require confirmation before saving. Each harness still needs to be selected, and operating-system permissions remain local. Older servers must be updated before using application-rule controls.

Install and start [Cua Driver](https://cua.ai/docs/cua-driver/quickstart) 0.38 or newer in the desktop session on each environment you want agents to operate. It is a separate prerequisite; T3 does not install Cua Spaces or copy OS permissions. On macOS, enable Cua Driver's Accessibility and Screen Recording permissions. T3's permission checks do not open those prompts.

Enable computer use and select the harness instances and permitted applications. A local executable override is available when the driver is outside the server's PATH. Desktop policy may come from the applied setup profile; an explicit local configuration takes precedence until you select **Use profile desktop policy**.

In a full-access/default thread, agents use `t3_computer_apps`, launch a permitted closed app through `t3_computer_control` when needed, acquire its app lease, and inspect a window with `t3_computer_observe`. Observation returns accessibility information and an image. Input is limited to that thread's leased app. The agent should observe after acting and release the desktop when finished.

Each lease binds an exact app process and window. One T3 thread controls an environment's desktop at a time. The lease expires after two idle minutes. Settings show its owner and provide **Release desktop**, including from mobile. Release cancels a pending driver request and prevents further calls with that lease. Direct Cua clients outside T3 do not participate in this coordination.

Driver availability, OS grants and a working desktop capture are distinct checks. A successful permission report does not prove a particular window can be captured; the first observation verifies that. Missing apps, permissions, an unavailable graphical session or a stale lease produce an error rather than selecting another desktop.
