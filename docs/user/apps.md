# Apps

Apps add tools such as work browsers to T3 without requiring an AI conversation.
Open **Apps** from the sidebar or mobile navigation. Installed apps also appear
by name in the command palette.

Choose the environment that owns the app. Its server runs the extension, so a
phone or remote browser does not need the extension's executable installed.
Apps require an updated T3 server and client.

Use **Install app** to import a JSON manifest supplied by an extension. Review
the executable and arguments before allowing installation: an installed app
runs that command on the selected environment. Generate manifests on that
environment so executable paths are correct. Keep credentials in the
extension's own configuration, not in manifest arguments.

Reading and changing data use separate connection permissions. T3 asks before
an app changes data. Uninstalling an app stops its connection and removes it
from T3; the extension's data stays with its server.

The initial app format supports self-contained HTML MCP app resources over
stdio. External network resources, downloads, and sending messages to an agent
are unavailable in standalone apps. An app can open related T3 threads or ask
to open an external link.
