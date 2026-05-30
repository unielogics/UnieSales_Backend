#!/usr/bin/env python3
"""
Insert a Nginx location block that maps the dynamic sales-training detail route
to the static-export placeholder file.

Without this block:
  GET /workspaces/<wid>/sales/training/<profileId>
  → falls through to /workspaces/_.html (the workspace home page)
  → operator clicks a profile card and lands on home instead of the workbench

With this block:
  → serves /workspaces/_/sales/training/_.html
  → ProductTrainingView reads wid + profileId via useRouteIds() and loads.

Idempotent: skips insertion if the block already exists.
"""
import re
import sys
import time

NEW_BLOCK = '''    # Doubly-nested dynamic route: /workspaces/<wid>/sales/training/<profileId>
    # (and any sub-path under it). Static export bakes the placeholder at
    # /workspaces/_/sales/training/_.html — without this block the single-
    # nested rule below would try /workspaces/_/sales/training/<real-id>.html,
    # fail, and fall through to the workspace home page.
    location ~ ^/workspaces/(?!_/|_$)[^/]+/sales/training/(?!_/|_$)[^/]+(/.*)?$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        try_files /workspaces/_/sales/training/_.html /index.html;
    }

'''

MARKER = '    # Single-nested: /workspaces/<wid>/<rest>'

def main(path: str) -> int:
    with open(path, 'r') as f:
        text = f.read()
    if 'location ~ ^/workspaces/(?!_/|_$)[^/]+/sales/training/' in text:
        print('already present, skipping')
        return 0
    if MARKER not in text:
        print(f'marker not found: {MARKER!r}', file=sys.stderr)
        return 1
    # Back up first
    backup = f'{path}.bak-{int(time.time())}'
    with open(backup, 'w') as f:
        f.write(text)
    text = text.replace(MARKER, NEW_BLOCK + MARKER)
    with open(path, 'w') as f:
        f.write(text)
    print(f'inserted; backup at {backup}')
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else '/etc/nginx/conf.d/uniesales.conf'))
