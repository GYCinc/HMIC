export const getDashboardHtml = (CORE_DASHBOARD_URL: string) => `

    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>HMIC // COMMAND CENTER</title>
        <style>
            :root {
              --bg: #0a0a0a;
              --term: #0f0f0f;
              --text: #00ff41;
              --dim: #008f11;
              --err: #ff0055;
              --warn: #ffaa00;
            }
            body {
              background: var(--bg);
              color: var(--text);
              font-family: 'Courier New', monospace;
              margin: 0;
              padding: 20px;
              overflow: hidden;
            }
            .container {
              display: grid;
              grid-template-columns: 300px 1fr;
              gap: 20px;
              height: 95vh;
            }
            .panel {
              background: var(--term);
              border: 1px solid var(--dim);
              padding: 15px;
              display: flex;
              flex-direction: column;
            }
            .panel-title {
              border-bottom: 1px solid var(--dim);
              padding-bottom: 8px;
              margin-bottom: 15px;
              text-transform: uppercase;
              letter-spacing: 2px;
            }
            .tool-item {
              padding: 10px;
              border: 1px solid var(--dim);
              background: #000;
              margin-bottom: 5px;
            }
            .status-running { color: var(--text); }
            .status-stopped { color: var(--err); }
            .status-starting { color: var(--warn); }
            .status-error { color: var(--err); }
            #logs {
              flex: 1;
              overflow-y: auto;
              font-size: 12px;
              line-height: 1.4;
              background: #000;
              padding: 10px;
              border: 1px solid var(--dim);
            }
            .log-entry {
              margin-bottom: 3px;
              border-left: 2px solid var(--dim);
              padding-left: 5px;
            }
            .log-err {
              color: var(--err);
              border-color: var(--err);
            }
            button {
              background: var(--dim);
              color: #000;
              border: none;
              padding: 8px 12px;
              cursor: pointer;
              font-family: inherit;
              font-weight: bold;
              margin: 5px 0;
            }
            button:hover {
              background: var(--text);
            }
            button:focus-visible {
              outline: 2px solid var(--text);
              outline-offset: 2px;
            }
            .core-frame {
              width: 100%;
              height: 300px;
              border: 1px solid var(--dim);
              background: #000;
            }
            .sync-btn {
              background: var(--text);
              color: #000;
              width: 100%;
              padding: 10px;
              margin-top: 10px;
            }
        </style>
      </head>
      <body>
        <h1>HMIC // COMMAND CENTER</h1>
        <div class="container">
          <div class="panel">
            <div class="panel-title">ACTIVE TOOLS</div>
            <div id="toolList"></div>
            <div class="panel-title" style="margin-top:20px">METRICS</div>
            <div>CPU: <span id="cpu">--</span>%</div>
            <div>MEM: <span id="mem">--</span>MB</div>
            <div>Requests: <span id="requests">0</span></div>
            <div>Active Tools: <span id="activeTools">0</span></div>

            <div class="panel-title" style="margin-top:20px">CORE MEMORY</div>
            <iframe class="core-frame" src="${CORE_DASHBOARD_URL}" title="Core Memory Visualization"></iframe>
            <button class="sync-btn" onclick="syncMemory()">SYNC VISUALIZATION</button>
          </div>
          <div class="panel">
            <div class="panel-title">LIVE FEED</div>
            <div id="logs"></div>
          </div>
        </div>

        <!-- VISUAL BUILDER MODAL -->
        <div id="builderModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:100;">
            <div style="background:var(--term); border:1px solid var(--text); margin:50px auto; width:80%; height:80%; padding:20px; display:flex; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid var(--dim); padding-bottom:10px;">
                    <div class="panel-title" style="margin:0;">VISUAL TOOL BUILDER</div>
                    <button onclick="document.getElementById('builderModal').style.display='none'" style="background:var(--err); color:#fff;">CLOSE</button>
                </div>
                <div style="display:flex; gap:20px; flex:1; overflow:hidden; margin-top:10px;">
                    <div style="width:300px; border-right:1px solid var(--dim); overflow-y:auto; padding-right:10px;">
                        <h3>1. Select Tool Host</h3>
                        <select id="builderHostSelect" style="width:100%; background:#000; color:var(--text); padding:5px; margin-bottom:10px;" onchange="loadHostTools()">
                            <option value="">-- Select Host --</option>
                        </select>
                        <h3>2. Select Function</h3>
                        <div id="builderToolList"></div>
                    </div>
                    <div style="flex:1; overflow-y:auto; padding-left:10px;">
                        <h3>3. Configure & Run</h3>
                        <div id="builderForm">Select a function to configure...</div>
                        <div id="builderResult" style="margin-top:20px; border:1px solid var(--dim); padding:10px; background:#000; display:none;">
                            <strong>RESULT:</strong>
                            <pre id="builderResultContent" style="white-space:pre-wrap;"></pre>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <button onclick="openBuilder()" style="position:fixed; bottom:20px; right:20px; z-index:50; background:var(--text); color:#000; padding:15px 30px; font-size:16px; border:2px solid #000;">OPEN VISUAL BUILDER</button>

        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          const logs = document.getElementById('logs');
          let availableHosts = [];

          socket.on('init', function(data) {
            availableHosts = data.tools;
            renderTools(data.tools);
            updateMetrics(data.metrics);
            updateBuilderHosts();
          });

          socket.on('tool_status', function(data) {
            // Refresh tool list when status changes
            fetch('/api/tools')
              .then(res => res.json())
              .then(tools => {
                  availableHosts = tools;
                  renderTools(tools);
                  updateBuilderHosts();
              });
          });

          socket.on('tool:result', function(data) {
              if (data.method === 'tools/list' && data.success) {
                  renderHostTools(data.toolId, data.result.tools);
              } else if (data.method === 'callTool') {
                  const resBox = document.getElementById('builderResult');
                  const resContent = document.getElementById('builderResultContent');
                  resBox.style.display = 'block';
                  if (data.success) {
                      resContent.style.color = 'var(--text)';
                      resContent.innerText = JSON.stringify(data.result, null, 2);
                  } else {
                      resContent.style.color = 'var(--err)';
                      resContent.innerText = 'ERROR: ' + data.error;
                  }
              }
          });

          socket.on('metrics', function(data) {
            document.getElementById('cpu').innerText = data.cpu.toFixed(1);
            document.getElementById('mem').innerText = (data.memory / 1024 / 1024).toFixed(0);
            document.getElementById('requests').innerText = data.total_requests;
            document.getElementById('activeTools').innerText = data.active_tools;
          });

          socket.on('log', function(msg) {
            const div = document.createElement('div');
            div.className = 'log-entry';
            if(msg.includes('ERR')) div.classList.add('log-err');
            const timestamp = new Date().toLocaleTimeString();
            div.innerHTML = \`[\${timestamp}] \${msg}\`;
            logs.appendChild(div);
            logs.scrollTop = logs.scrollHeight;
          });

          function renderTools(tools) {
            const toolList = document.getElementById('toolList');
            toolList.innerHTML = tools.map(function(t) {
              return '<div class="tool-item">' +
                '<strong class="status-' + t.status + '">' + t.name + '</strong><br>' +
                '<small>' + t.status.toUpperCase() + ' (PID: ' + (t.pid || 'N/A') + ')</small><br>' +
                '<button onclick="stopTool(\\'' + t.id + '\\')" aria-label="Stop ' + t.name + '">STOP</button>' +
              '</div>';
            }).join('');
          }

          function updateMetrics(metrics) {
            document.getElementById('requests').innerText = metrics.totalRequests || 0;
          }

          function stopTool(toolId) {
            fetch('/api/tools/' + toolId + '/stop', { method: 'POST' })
              .then(res => res.json())
              .then(data => {
                console.log('Tool stopped:', data);
              });
          }

          // --- VISUAL BUILDER FUNCTIONS ---
          function openBuilder() {
              document.getElementById('builderModal').style.display = 'block';
              updateBuilderHosts();
          }

          function updateBuilderHosts() {
              const sel = document.getElementById('builderHostSelect');
              const current = sel.value;
              sel.innerHTML = '<option value="">-- Select Host --</option>';
              availableHosts.forEach(t => {
                  if (t.status === 'running') {
                      const opt = document.createElement('option');
                      opt.value = t.id;
                      opt.text = t.name;
                      sel.appendChild(opt);
                  }
              });
              sel.value = current;
          }

          function loadHostTools() {
              const hostId = document.getElementById('builderHostSelect').value;
              document.getElementById('builderToolList').innerHTML = 'Loading...';
              document.getElementById('builderForm').innerHTML = 'Select a function...';
              document.getElementById('builderResult').style.display = 'none';

              if (!hostId) return;

              // Request tool list from server
              socket.emit('tool:call', {
                  toolId: hostId,
                  method: 'tools/list',
                  params: {}
              });
          }

          function renderHostTools(hostId, tools) {
              const list = document.getElementById('builderToolList');
              list.innerHTML = '';
              tools.forEach(tool => {
                  const btn = document.createElement('div');
                  btn.className = 'tool-item';
                  btn.style.cursor = 'pointer';
                  btn.innerHTML = '<strong>' + tool.name + '</strong><br><small>' + (tool.description || '').substring(0, 50) + '...</small>';
                  btn.onclick = () => renderToolForm(hostId, tool);
                  list.appendChild(btn);
              });
          }

          function renderToolForm(hostId, tool) {
              const formDiv = document.getElementById('builderForm');
              formDiv.innerHTML = '<h3>Configure: ' + tool.name + '</h3><p>' + (tool.description || '') + '</p>';

              const schema = tool.inputSchema || {};
              const props = schema.properties || {};
              const required = schema.required || [];

              const form = document.createElement('form');
              form.onsubmit = (e) => {
                  e.preventDefault();
                  const formData = new FormData(form);
                  const args = {};
                  for (let [key, value] of formData.entries()) {
                      // Basic type conversion
                      if (props[key] && props[key].type === 'number') value = Number(value);
                      if (props[key] && props[key].type === 'boolean') value = (value === 'on');
                      if (value !== '') args[key] = value;
                  }

                  runTool(hostId, tool.name, args);
              };

              Object.keys(props).forEach(key => {
                  const field = props[key];
                  const div = document.createElement('div');
                  div.style.marginBottom = '10px';

                  const label = document.createElement('label');
                  label.innerText = key + (required.includes(key) ? '*' : '') + ': ';
                  label.style.display = 'block';
                  label.style.color = 'var(--dim)';

                  let input;
                  if (field.type === 'boolean') {
                      input = document.createElement('input');
                      input.type = 'checkbox';
                  } else {
                      input = document.createElement('input');
                      input.type = 'text';
                      input.style.width = '100%';
                      input.style.background = '#000';
                      input.style.border = '1px solid var(--dim)';
                      input.style.color = 'var(--text)';
                      input.style.padding = '5px';
                      if (field.description) input.placeholder = field.description;
                  }
                  input.name = key;
                  if (required.includes(key)) input.required = true;

                  div.appendChild(label);
                  div.appendChild(input);
                  form.appendChild(div);
              });

              const submit = document.createElement('button');
              submit.innerText = 'RUN TOOL';
              submit.style.marginTop = '10px';
              submit.style.width = '100%';

              form.appendChild(submit);
              formDiv.appendChild(form);
          }

          function runTool(hostId, toolName, args) {
              const resContent = document.getElementById('builderResultContent');
              resContent.innerText = 'Running...';
              document.getElementById('builderResult').style.display = 'block';

              socket.emit('tool:call', {
                  toolId: hostId,
                  method: 'callTool',
                  params: {
                      name: toolName,
                      arguments: args
                  }
              });
          }

          function syncMemory() {
            const btn = document.querySelector('.sync-btn');
            const originalText = btn.innerText;
            btn.innerText = 'SYNCING...';
            btn.disabled = true;

            socket.emit('tool:call', {
              toolId: 'core-memory-bridge',
              method: 'callTool',
              params: {
                name: 'memory_ingest',
                arguments: {
                  sessionId: 'dashboard-sync',
                  message: 'Manual Sync triggered from HMIC Dashboard.'
                }
              }
            });

            setTimeout(() => {
              btn.innerText = 'SYNC COMPLETE';
              setTimeout(() => {
                btn.innerText = originalText;
                btn.disabled = false;
              }, 2000);
            }, 3000);
          }
        </script>
      </body>
    </html>

`;
