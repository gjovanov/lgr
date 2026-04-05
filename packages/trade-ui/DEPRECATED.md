# DEPRECATED

This package has been superseded by three focused apps:

- **inventory-ui** (`/inventory/`) — Products, stock, movements, valuations
- **invoicing-ui** (`/invoicing/`) — Contacts, invoices, payments
- **pos-ui** (`/pos/`) — Point of sale, sessions, fiscal

This package is kept for one release cycle for backward compatibility.
The unified server serves `/trade/*` routes from trade-ui dist if present,
but the canonical apps are inventory-ui, invoicing-ui, and pos-ui.
