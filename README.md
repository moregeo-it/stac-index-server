# STAC Index

A centralized platform for managing, indexing, and providing STAC (SpatioTemporal Asset Catalog) Collection metadata from distributed catalogs and APIs.

---

## Table of Contents

1. [Motivation](#motivation)
2. [System Overview](#system-overview)
   - [Architecture](#architecture)
   - [Component Interaction](#component-interaction)
3. [Features](#features)
4. [Quick Start](#quick-start)
   - [Full System Deployment](#full-system-deployment)
   - [Individual Component Deployment](#individual-component-deployment)
5. [System Components](#system-components)
   - [Database](#database)
   - [Crawler](#crawler)
   - [API](#api)
6. [Technology Stack](#technology-stack)
7. [Ports and Networking](#ports-and-networking)
8. [Environment Configuration](#environment-configuration)
9. [Testing](#testing)
10. [STAC Conformance](#stac-conformance)
11. [Target Audience](#target-audience)
12. [Scope and Limitations](#scope-and-limitations)
13. [Project Structure](#project-structure)
14. [License](#license)
15. [Maintainers](#maintainers)
16. [Credits](#credits)

---

## Motivation

In the current geodata landscape, numerous decentralized STAC catalogs and APIs from various data providers exist, making it difficult to discover and access relevant geodata collections. Researchers, GIS professionals, and application developers often need to manually search through individual STAC catalogs to find the datasets they need.

STAC Index addresses this problem by serving as a centralized access point that aggregates metadata from various sources and makes it searchable. The platform enables users to search, filter, and compare collections across providers without having to manually browse each individual STAC catalog.

By implementing standard-compliant interfaces (STAC API), programmatic access by developers as well as integration into existing STAC clients and web frontends is enabled. This significantly increases efficiency when working with geodata and promotes the reusability of data resources.

---

## System Overview

This repository contains the server side of STAC Index — three components that work together seamlessly:

| Component | Description |
|-----------|-------------|
| **Database** | PostgreSQL with PostGIS for persistent storage and efficient spatial queries |
| **Crawler** | Automatically discovers and indexes STAC Collections from distributed sources |
| **API** | Provides STAC-compliant programmatic access to indexed collections |

Any STAC-compliant client can consume the API; the web frontend is maintained in its own repository.

### Architecture

```
                                    ┌─────────────────┐
                                    │  stacindex.org  │
                                    │ (legacy, extern)│
             Crawls Data            └────────┬────────┘
            ┌────────────────────────────────┘
            │                                
┌───────────│─────────────────────────────────────────────────────────────┐
│           │            STAC Index Server                                │
│           │                                                             │
│   ┌───────│─────┐         ┌─────────────┐         ┌─────────────┐       │
│   │             │  write  │             │  read   │             │       │
│   │   Crawler   ├────────►│  Database   │◄────────┤    API      │       │
│   │   (Node.js) │         │ (PostgreSQL │         │  (Node.js)  │       │
│   │             │         │  + PostGIS) │         │             │       │
│   └─────────────┘         └─────────────┘         └──────┬──────┘       │
│                                                          │              │
└──────────────────────────────────────────────────────────│──────────────┘
                                                           │ HTTP/JSON
                                                           │
                                                    ┌──────▼──────┐
                                                    │   Clients   │
                                                    │ (web front- │
                                                    │ ends, tools)│
                                                    └─────────────┘
```

### Component Interaction

The components interact in a well-defined data flow:

1. **Crawler to Database**: The crawler fetches STAC catalogs and APIs from the legacy STAC Index (stacindex.org), validates and normalizes the data, then writes collections to the PostgreSQL database. It tracks crawl progress to enable pause/resume functionality and periodic re-crawling.

2. **API to Database**: The API reads from the database using parameterized SQL queries. It translates CQL2 filter expressions into PostgreSQL WHERE clauses and leverages PostGIS for spatial queries and TSVector for full-text search.

3. **Clients to API**: External clients communicate with the API via HTTP/JSON. They use the STAC-compliant endpoints to search, filter, and retrieve collection metadata. No client accesses the database directly.

4. **Crawler Independence**: The crawler operates independently from the API. It can run as a one-time job or as a scheduled service, updating the database without affecting API availability.

---

## Features

### Core Capabilities

- **Automated Indexing**: Crawls and indexes STAC Collections from static catalogs and STAC APIs listed in the legacy STAC Index (stacindex.org)
- **Recursive Navigation**: Traverses nested catalog structures with configurable depth limits
- **Incremental Updates**: Supports pause/resume and periodic re-crawling without full re-indexing
- **STAC Validation**: Validates collections against official STAC schemas before storage

### Search and Filtering

- **Full-Text Search**: PostgreSQL TSVector-based search across titles, descriptions, and keywords
- **Spatial Filtering**: PostGIS-powered bounding box and geometry intersection queries
- **Temporal Filtering**: Date range queries supporting open-ended intervals
- **CQL2 Support**: Advanced filtering using Common Query Language 2 (both text and JSON encodings)
- **Multi-Criteria Queries**: Combine provider, license, keywords, and custom filters

### API Features

- **STAC Compliant**: Implements STAC API Core, Collections, and Collection Search Extension
- **Queryables Endpoint**: Dynamic JSON Schema describing available filter properties with live enumeration values
- **Pagination**: Efficient navigation through large result sets
- **Sorting**: Configurable sort order by various fields
- **Health Monitoring**: Kubernetes-ready health check endpoint

---

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- At least 4 GB RAM recommended
- Ports 3000 and 5432 available

### Full System Deployment

The entire STAC Index system can be started with a single command:

```bash
# Clone the repository
git clone https://github.com/moregeo-it/stac-index-server.git
cd stac-index-server

# Create shared credentials once (injected into db, api, crawler)
cp .env.example .env
# Edit .env — set passwords here only

# Optional component settings (no DB passwords needed for full stack)
cp crawler/.env.example crawler/.env
cp api/.env.example api/.env

# Start all services
docker compose up --build -d
```


This starts:
- **Database** on port 5432
- **API** on port 3000

**Note** that the links in the API responses (and the OpenAPI `servers` entry) follow the URL the request came in through: requested via `http://localhost:3000`, the links point at `http://localhost:3000`; requested via `https://stacindex.org/api`, they point there. The URL is read from the `Host` header and the proxy headers `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-Prefix`.

`API_BASE_URL` in the root `.env` adds the path prefix for requests coming in via its host — the production deployment is served at `https://stacindex.org/api`:

```env
API_BASE_URL=https://stacindex.org/api
```

Requests to `stacindex.org` then get links prefixed with `/api`. The application itself always serves its routes at the root (`/collections`, `/health`, …), so the reverse proxy has to strip the prefix before forwarding:

```nginx
location /api/ {
    proxy_pass http://api:3000/;   # trailing slash strips the /api prefix
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Prefix /api;   # optional, makes API_BASE_URL unnecessary
}
```

This process will create first of all a new Database under your given Port. If this step is done, the Crawler will be started and will automatically beginn to fill you new Database with crawled Collections. The API will also be started in this step. Be aware that it can take multiple minutes until the crawler inserts the first Collections into the Databse.

### Individual Component Deployment

Each component can also be deployed independently. This is useful for development, scaling, or integrating with existing infrastructure.

#### Database Only

```bash
cd db
cp .env.example .env
# Edit .env with your passwords
docker-compose up -d
```

#### Crawler Only

After the database and API are running, populate the database with STAC collections:

```bash
cd crawler
npm install

# Configure environment
cp .env.example .env
# Edit .env with database credentials

# Run a single crawl
npm start

# Or run the scheduler for periodic crawling
node scheduler.js
```

#### API Only

```bash
cd api
cp .env.example .env
# Edit .env with database connection details
docker compose up --build

# Or use npm
npm install
npm start
```

For a more detailed component-specific instructions, see the README files in each component directory. [db/README.md](./db/README.md), [crawler/README.md](./crawler/README.md), [api/README.md](./api/README.md)

---

## System Components

### Database

The database layer uses PostgreSQL 16 with PostGIS 3.4 for spatial data support. It implements a normalized schema designed for efficient querying of STAC collection metadata.

**Key Features:**
- Spatial indexing with GiST for bounding box queries
- Full-text search with GIN indexes and TSVector
- Normalized tables with referential integrity
- Role-based access control (read-only API user, read-write crawler user)
- Automatic search vector updates via triggers

**Schema Highlights:**
- `collection` - Main metadata table with spatial/temporal extents
- `keywords`, `providers`, `stac_extensions` - Lookup tables for many-to-many relationships
- `collection_summaries` - Statistical summaries of collection properties
- `crawllog_catalog`, `crawllog_collection` - Crawler progress tracking

For complete database documentation including ER diagrams and initialization scripts, see [db/README.md](db/README.md).

### Crawler

The crawler is a Node.js application that discovers and indexes STAC Collections from the legacy STAC Index (stacindex.org). It supports both static catalogs and STAC APIs, with intelligent rate limiting and domain-based parallel processing.

**Key Features:**
- Single-run and scheduled modes
- Configurable depth limits and timeouts
- Domain-based parallel processing with per-domain rate limiting
- Graceful shutdown with pause/resume support
- STAC validation using stac-node-validator
- Automatic cleanup of stale collections

**Crawling Modes:**
- `catalogs` - Crawl only static STAC catalogs
- `apis` - Crawl only STAC APIs
- `both` - Crawl both (default)

**Example Usage:**
```bash
# Quick test crawl
node index.js --mode apis --max-apis 3

# Full production crawl
node index.js --mode both --max-catalogs 0 --max-apis 0

# Start scheduler for weekly re-crawling
node scheduler.js
```

For complete crawler documentation including configuration options and examples, see [crawler/README.md](crawler/README.md).

### API

The API provides STAC-compliant access to indexed collections. Built with Express.js, it implements the STAC API specification with Collection Search Extension and CQL2 filtering.

**Endpoints:**

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page with links to all resources |
| `GET /conformance` | List of implemented conformance classes |
| `GET /collections` | Paginated list of collections with filtering |
| `GET /collections/{id}` | Single collection by identifier |
| `GET /collection-queryables` | JSON Schema of queryable properties |
| `GET /health` | Health check for monitoring |
| `GET /api-docs` | Swagger UI documentation |

**Query Parameters:**
- `q` - Full-text search
- `bbox` - Spatial filter (minLon,minLat,maxLon,maxLat)
- `datetime` - Temporal filter (ISO8601 interval)
- `provider` - Filter by provider name
- `license` - Filter by license identifier
- `api`- Boolean, whether a Collection is provided by an STAC API
- `active` - Boolean, whether a collection is still available
- `filter` - CQL2 filter expression
- `filter-lang` - CQL2 encoding (cql2-text or cql2-json)
- `sortby` - Sort field and direction
- `limit` - Results per page (1-10000)
- `token` - Pagination offset

For complete API documentation including CQL2 examples, see [api/README.md](api/README.md).

---

## Technology Stack

### Core Technologies

| Component | Technology | Version |
|-----------|------------|---------|
| Database | PostgreSQL | 16 |
| Spatial Extension | PostGIS | 3.4 |
| API Runtime | Node.js | 22+ |
| API Framework | Express.js | 4.x |
| CQL2 Parser | cql2-wasm | - |
| Crawler Runtime | Node.js | 22+ |
| Crawler Framework | Crawlee | 3.x |

### Development Tools

| Purpose | Technology |
|---------|------------|
| Testing | Jest, Supertest |
| Linting | ESLint |
| API Documentation | Swagger UI, OpenAPI 3.0 |
| Containerization | Docker, Docker Compose |

---

## Ports and Networking

| Service | Port | Description |
|---------|------|-------------|
| API | 3000 | STAC API endpoints |
| Database | 5432 | PostgreSQL connection |

When running with Docker Compose, all services communicate over the `stac_net` internal network. External access is provided through the mapped ports.

---

## Environment Configuration

### Full stack (recommended)

Create **one** root `.env` from `.env.example`. Passwords and DB name/user are injected into `db`, `api` and `crawler` by the root `docker-compose.yml` — you do not repeat them elsewhere.

```env
POSTGRES_DB=example
POSTGRES_USER=example
POSTGRES_PASSWORD=example
DB_PORT=5432
STAC_API_PASSWORD=example
STAC_CRAWLER_PASSWORD=example
API_BASE_URL=http://localhost:3000
```

Optional component files (no shared secrets):

- `crawler/.env` — crawl settings only (`CRAWL_*`, `MAX_*`, …)
- `api/.env` — API settings only (CORS, pool, logging, …)

### Standalone components

When running a component alone, use that component’s example file (including DB connection settings). For the database alone: `db/.env.example`.

For in depth configuration options, have a look into the README files in each component directory. [db/README.md](./db/README.md), [crawler/README.md](./crawler/README.md), [api/README.md](./api/README.md)

---

## Testing

### API Tests

```bash
cd api
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run lint                # Code linting
```

### Crawler Tests

```bash
cd crawler
npm test                    # Run all tests
npm run test:watch          # Watch mode
```

### STAC API Validation

The API can be validated using the official STAC API Validator:

```bash
pip install stac-api-validator
python -m stac_api_validator --root-url http://localhost:3000 --conformance core --collections --collection {collectionID}
```

---

## STAC Conformance

STAC Index implements the following conformance classes:

- "https://api.stacspec.org/v1.0.0/core"
- "https://api.stacspec.org/v1.0.0/collections"
- "https://api.stacspec.org/v1.0.0/collection-search"
- "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/simple-query"
- "https://api.stacspec.org/v1.0.0-rc.1/collection-search#free-text"
- "https://api.stacspec.org/v1.0.0-rc.1/collection-search#filter"
- "https://api.stacspec.org/v1.1.0/collection-search#sort"
- "http://www.opengis.net/spec/cql2/1.0/conf/basic-cql2"
- "http://www.opengis.net/spec/cql2/1.0/conf/advanced-comparison-operators"
- "http://www.opengis.net/spec/cql2/1.0/conf/cql2-json"
- "http://www.opengis.net/spec/cql2/1.0/conf/cql2-text"
- "http://www.opengis.net/spec/cql2/1.0/conf/basic-spatial-functions"
- "http://www.opengis.net/spec/cql2/1.0/conf/spatial-functions"
- "http://www.opengis.net/spec/cql2/1.0/conf/temporal-functions"
- "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/collections"
- "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core"
- "https://api.stacspec.org/v1.1.0/collection-search#sortables"

The full list of conformance URIs is also available at `GET /conformance`.

---

## Target Audience

STAC Index is designed for several user groups:

### Data Scientists and Researchers
- Search for satellite imagery by region and time period
- Compare collections from different providers
- Filter by specific attributes (resolution, sensor type, etc.)
- Integrate searches into analysis pipelines via API

### GIS Professionals
- Spatial search for collections in project areas via bbox and CQL2 geometry filters
- Filter by license for commercial use cases
- Evaluate temporal availability across providers
- Quick identification of relevant data sources

### Application Developers
- Programmatic access via STAC-compliant API
- CQL2 filtering for complex queries
- Integration with existing geodata infrastructure
- Standardized response formats

### Data Providers
- Increased visibility for STAC catalogs
- Automatic indexing through crawler
- No additional integration effort required

---

## Scope and Limitations

### What STAC Index Does

- Indexes and searches STAC Collections from distributed sources
- Provides STAC-compliant API access to aggregated metadata
- Maintains periodic updates through scheduled crawling

### What STAC Index Does NOT Do

- Store individual STAC Items (only Collections)
- Replace original STAC Catalogs (serves as aggregation layer)
- Store or process original geodata (raster/vector data)
- Implement authentication or user management
- Provide write access to external STAC catalogs
- Perform data analysis or processing
- Serve as a download portal for geodata
- Guarantee real-time synchronization with source catalogs

---

## Project Structure

```
stac-index/
├── api/                    # STAC API server
│   ├── bin/                # Server entry point
│   ├── config/             # Configuration files
│   ├── db/                 # Database connection and queries
│   ├── middleware/         # Express middleware
│   ├── routes/             # API route handlers
│   ├── utils/              # Utility functions
│   ├── __tests__/          # Test files
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── README.md
├── crawler/                # STAC Crawler
│   ├── catalogs/           # Static catalog crawling
│   ├── apis/               # STAC API crawling
│   ├── utils/              # Crawler utilities
│   ├── __tests__/          # Test files
│   ├── index.js            # Single-run entry point
│   ├── scheduler.js        # Scheduled crawling
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── README.md
├── db/                     # Database setup
│   ├── init/               # Initialization scripts
│   ├── migrations/         # Schema migrations
│   ├── docker-compose.yml
│   └── README.md
├── docker-compose.yml      # Full system orchestration (db, crawler, api)
├── bid.md                  # Project requirements (German)
├── LICENSE
└── README.md               # This file
```

---

## License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.

---

## Maintainers

STAC Index is maintained by **[MoreGeo](https://moregeo.it)** — [github.com/moregeo-it](https://github.com/moregeo-it).

---

## Credits

This project builds on **SpatioCore / STAC Atlas**, developed as part of the Geosoftware II course at the University of Muenster (Winter Semester 2025/2026).

**Original Team:**
- Database: Sönke Hoffmann
- Crawler: Humam Hikmat (Team-Lead), Lenn Kruck, Jakob Wotka
- API: Robin Gummels (Team- & Project-Lead), Vincent Kuehn, Jonas Klaer

**Supervisors:**
- Dr. Christian Knoth
- Matthias Mohr

---

## Further Reading

- [STAC Specification](https://stacspec.org/)
- [STAC API Specification](https://api.stacspec.org/)
- [OGC CQL2 Standard](https://docs.ogc.org/is/21-065r2/21-065r2.html)
- [Legacy STAC Index](https://stacindex.org/) — upstream catalog source