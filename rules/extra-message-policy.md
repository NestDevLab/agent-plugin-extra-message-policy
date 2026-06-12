# Extra Message Policy

Policy intent shared by OpenClaw and Hermes runtimes:

- never bypass platform read/send permissions;
- never bypass agent allow-lists or pairing/authorization;
- passive ingest must not imply a reply;
- reply suppression must be explicit and auditable;
- raw recall must be bounded by days, match count, and character budget.
