import { spawn, ChildProcess } from 'child_process';
import http from 'http';

const PORT = 3000;
const DURATION_MS = 5000; // 5 seconds benchmark
const CONCURRENCY = 50;

function startServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        const tsNode = './node_modules/.bin/ts-node';
        const server = spawn(tsNode, ['src/index.ts'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PORT: String(PORT),
                LOG_LEVEL: 'info',
                // Disable auth for benchmark to measure raw throughput
                HTTP_USER: '',
                HTTP_PASSWORD: ''
            }
        });

        server.stdout.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('HMIC Hub listening on port')) {
                resolve(server);
            }
        });

        server.stderr.on('data', (data) => {
             // console.error(`Server Error: ${data}`);
        });

        server.on('error', reject);
    });
}

async function runBenchmark() {
    console.log('Starting server...');
    const server = await startServer();
    console.log('Server started. Warming up...');

    // Warmup
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('Starting benchmark...');
    let requests = 0;
    let errors = 0;
    const startTime = Date.now();
    let active = 0;
    let running = true;

    const makeRequest = () => {
        if (!running) return;

        active++;
        const req = http.get(`http://localhost:${PORT}/`, {
            agent: new http.Agent({ keepAlive: true }) // use keep-alive
        }, (res) => {
            res.resume(); // consume body
            if (res.statusCode === 200) {
                requests++;
            } else {
                errors++;
            }
            active--;
            makeRequest();
        });

        req.on('error', (e) => {
            errors++;
            active--;
            makeRequest();
        });
    };

    // Start concurrent requests
    for (let i = 0; i < CONCURRENCY; i++) {
        makeRequest();
    }

    // Wait for duration
    await new Promise(resolve => setTimeout(resolve, DURATION_MS));
    running = false;

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    const rps = requests / duration;

    console.log(`\nResults:`);
    console.log(`Duration: ${duration.toFixed(2)}s`);
    console.log(`Requests: ${requests}`);
    console.log(`Errors: ${errors}`);
    console.log(`RPS: ${rps.toFixed(2)} req/sec`);

    server.kill();
}

runBenchmark().catch(console.error);
