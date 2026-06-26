# AKB - Aamer Knowledge Base

AKB is an internal knowledge base prototype for Aamer employees and call center staff.

## What is included

- Employee search portal
- Admin dashboard for adding services
- Backend API using Node.js
- JSON database stored in `database/akb-db.json`
- Service pages with requirements, steps, fees, processing time, FAQs, call center script, internal notes, and escalation contact
- Change log for created and updated services
- Search without AI

## Port Ranges

| Environment | Port range | AKB default |
| --- | --- | --- |
| Dev | 3040 - 3049 | 3040 |
| UAT | 4040 - 4049 | 4040 |
| Prod | 5040 - 5049 | 5040 |

Use `PORT=3040` for local development, `PORT=4040` for UAT, and `PORT=5040` for production unless another port in the approved range is needed.

## Run locally

```bash
PORT=3040 npm start
```

Then open:

```text
http://localhost:3040
```

## Project structure

```text
AKB/
  backend/server.js       Backend API and static web server
  frontend/index.html     Frontend layout
  frontend/styles.css     Frontend design
  frontend/app.js         Frontend behavior and API calls
  database/akb-db.json    Local database
  package.json            App scripts
  README.md               Project notes
```

## Adding services

Open the Admin Dashboard in AKB. Fill the service fields, then use:

- Publish and view: saves the service and opens it in the employee search portal.
- Save and add another: saves the service and keeps you on the form for the next one.
- Clear form: empties the form without saving.

FAQs can be added as blocks:

```text
Question: Can customer apply by phone?
Answer: No, documents must be submitted first.
```

## Real launch upgrade path

For production, the JSON database can be replaced with PostgreSQL while keeping the same service structure. The next launch steps are login, roles, approval workflow, file uploads, audit permissions, and deployment on a company server or private cloud.

## Docker

Run AKB with Docker Compose:

```bash
docker compose up -d --build

# UAT example
AKB_PORT=4040 docker compose up -d --build

# Prod example
AKB_PORT=5040 docker compose up -d --build
```

Open http://localhost:3040.

## Git push helper

Use the push helper when you want to push to an existing branch or create a new branch:

```bash
./git-push-akb.sh branch-name
```

Optional commit message:

```bash
./git-push-akb.sh branch-name "Update AKB services"
```

The script will switch/create the branch, stage changes, commit if needed, and push with upstream.

## Public repo note

This repository is public-safe. Passwords in `database/akb-db.json` are demo/reset values only. Change all passwords from the Admin Panel before using AKB internally or on a server.
