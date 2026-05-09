# node-client-manager

Node app for managing browser clients in rooms.

```sh
# Windows
.\install_and_run.bat

# Linux
chmod +x install_and_run.sh
./install_and_run.sh
```

Open:

- Manager: http://127.0.0.1:3000
- Client page: http://127.0.0.1:3000/instance

Optional quick check:

```sh
curl http://127.0.0.1:3000/api/health
```

Run tests:

```sh
cd web-manager-node
npm test
```

One-line test command:

```sh
cd web-manager-node && npm test
```

Tests currently cover:

- room normalization
- room action command mapping
- room link generation
