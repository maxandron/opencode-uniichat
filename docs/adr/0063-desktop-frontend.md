# 0063: A desktop frontend beside the terminal UI

Add an experimental `./gui-experimental` export for OpenCode Desktop, built with the host's Vite preset and native Solid components. Keep memory ownership and the RPC contract on the server; only the presentation differs from the TUI. Route each call through the displayed session's server, scope panel state by server and session, and cancel pending work on disposal so a late reply cannot expose another session's memory. Ship the GUI bundle prebuilt, just like the TUI, and require OpenCode 2.2 for the new SDK.
