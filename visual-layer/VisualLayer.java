
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Scanner;
import java.util.concurrent.Executors;

public class VisualLayer {

    private static final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .build();
    private static final String HUB_URL = "http://localhost:3000/api/tools";

    public static void main(String[] args) throws IOException {
        int port = 2727;
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        server.createContext("/", new DashboardHandler());
        server.createContext("/api/proxy", new ProxyHandler());
        server.setExecutor(Executors.newFixedThreadPool(50));
        server.start();

        System.out.println("Java Visual Layer started on port " + port);
        System.out.println("Access the dashboard at http://localhost:" + port);

        // CLI Loop
        new Thread(() -> {
            Scanner scanner = new Scanner(System.in);
            System.out.println("CLI Interface Ready. Type 'help' for commands.");
            while (scanner.hasNextLine()) {
                String line = scanner.nextLine().trim();
                if ("exit".equalsIgnoreCase(line)) {
                    System.out.println("Shutting down...");
                    server.stop(0);
                    System.exit(0);
                } else if ("help".equalsIgnoreCase(line)) {
                    System.out.println("Commands: help, exit, status, tools");
                } else if ("status".equalsIgnoreCase(line)) {
                    System.out.println("Server running on port " + port);
                    checkHubConnectivity();
                } else if ("tools".equalsIgnoreCase(line)) {
                    fetchTools();
                } else if (!line.isEmpty()) {
                    System.out.println("Unknown command: " + line);
                }
            }
        }).start();
    }

    private static void checkHubConnectivity() {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create("http://localhost:3000/health"))
                    .GET()
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 200) {
                System.out.println("Hub Connectivity: OK (200) - " + response.body());
            } else {
                System.out.println("Hub Connectivity: WARN (" + response.statusCode() + ")");
            }
        } catch (Exception e) {
            System.out.println("Hub Connectivity: FAILED (" + e.getMessage() + ")");
        }
    }

    private static void fetchTools() {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(HUB_URL))
                    .GET()
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            System.out.println("Tools: " + response.body());
        } catch (Exception e) {
            System.out.println("Failed to fetch tools: " + e.getMessage());
        }
    }

    static class DashboardHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            String html = """
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>HMIC Visual Layer (Java)</title>
                    <style>
                        :root { --bg: #0a0a0a; --card: #141414; --accent: #00ff41; --text: #e0e0e0; --dim: #888; }
                        body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; }
                        h1 { color: var(--accent); border-bottom: 2px solid var(--accent); padding-bottom: 10px; }
                        .status-bar { background: var(--card); padding: 15px; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
                        .status-indicator { width: 12px; height: 12px; border-radius: 50%; background: #444; display: inline-block; margin-right: 8px; }
                        .online { background: #00ff41; box-shadow: 0 0 10px #00ff41; }
                        .offline { background: #ff0055; }
                        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
                        .card { background: var(--card); padding: 20px; border-radius: 8px; border: 1px solid #333; transition: transform 0.2s; }
                        .card:hover { transform: translateY(-2px); border-color: var(--accent); }
                        .card h3 { margin-top: 0; color: var(--accent); }
                        .terminal { background: #000; border: 1px solid #333; padding: 10px; font-family: monospace; height: 200px; overflow-y: auto; color: #ccc; margin-top: 20px; }
                        button { background: var(--accent); color: #000; border: none; padding: 8px 16px; border-radius: 4px; font-weight: bold; cursor: pointer; }
                        button:hover { opacity: 0.9; }
                        button.stop { background: #ff0055; color: white; }
                        .refresh-btn { background: #333; color: white; }
                    </style>
                </head>
                <body>
                    <h1>HMIC // VISUAL LAYER</h1>

                    <div class="status-bar">
                        <div>
                            <span id="hubStatusInd" class="status-indicator"></span>
                            <span id="hubStatusText">Checking Hub Connectivity...</span>
                        </div>
                        <button class="refresh-btn" onclick="fetchTools()">Refresh Data</button>
                    </div>

                    <div id="toolsGrid" class="grid">
                        <!-- Tools will be injected here -->
                    </div>

                    <div class="terminal" id="activityLog">
                        <div>> Visual Layer Initialized (Java Backend)</div>
                    </div>

                    <script>
                        const HUB_API = 'http://localhost:3000/api/tools';
                        const HEALTH_API = 'http://localhost:3000/health';

                        function log(msg) {
                            const term = document.getElementById('activityLog');
                            const div = document.createElement('div');
                            div.textContent = `> ${new Date().toLocaleTimeString()} ${msg}`;
                            term.appendChild(div);
                            term.scrollTop = term.scrollHeight;
                        }

                        async function checkHealth() {
                            try {
                                const res = await fetch(HEALTH_API);
                                if (res.ok) {
                                    document.getElementById('hubStatusInd').className = 'status-indicator online';
                                    document.getElementById('hubStatusText').textContent = 'Hub Online';
                                    return true;
                                } else {
                                    throw new Error(res.statusText);
                                }
                            } catch (e) {
                                document.getElementById('hubStatusInd').className = 'status-indicator offline';
                                document.getElementById('hubStatusText').textContent = 'Hub Offline (Is Node app running?)';
                                log('Health check failed: ' + e.message);
                                return false;
                            }
                        }

                        async function fetchTools() {
                            const online = await checkHealth();
                            if (!online) return;

                            try {
                                const res = await fetch(HUB_API);
                                const tools = await res.json();
                                renderTools(tools);
                                log(`Fetched ${tools.length} tools`);
                            } catch (e) {
                                log('Failed to fetch tools: ' + e.message);
                            }
                        }

                        function renderTools(tools) {
                            const grid = document.getElementById('toolsGrid');
                            grid.innerHTML = tools.map(t => `
                                <div class="card">
                                    <h3>${t.name}</h3>
                                    <p>${t.description || 'No description'}</p>
                                    <p>Status: <strong style="color: ${t.status === 'running' ? '#00ff41' : '#ffaa00'}">${t.status.toUpperCase()}</strong></p>
                                    <p>PID: ${t.pid || 'N/A'}</p>
                                    <p>Restarts: ${t.restartCount}</p>
                                    ${t.status === 'running' ? `<button class="stop" onclick="stopTool('${t.id}')">STOP TOOL</button>` : ''}
                                </div>
                            `).join('');
                        }

                        async function stopTool(id) {
                            if(!confirm('Stop tool ' + id + '?')) return;
                            try {
                                await fetch(`http://localhost:3000/api/tools/${id}/stop`, { method: 'POST' });
                                log(`Command sent: STOP ${id}`);
                                setTimeout(fetchTools, 1000);
                            } catch (e) {
                                log('Error stopping tool: ' + e.message);
                            }
                        }

                        // Auto-refresh
                        fetchTools();
                        setInterval(fetchTools, 5000);
                    </script>
                </body>
                </html>
            """;

            t.getResponseHeaders().add("Content-Type", "text/html");
            t.sendResponseHeaders(200, html.length());
            OutputStream os = t.getResponseBody();
            os.write(html.getBytes(StandardCharsets.UTF_8));
            os.close();
        }
    }

    static class ProxyHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange t) throws IOException {
            // Simple proxy example if needed to avoid CORS on client side
            // (though we enabled CORS in Node app, so direct fetch is fine)
            String response = "Proxy not implemented yet";
            t.sendResponseHeaders(501, response.length());
            t.getResponseBody().write(response.getBytes());
            t.getResponseBody().close();
        }
    }
}
