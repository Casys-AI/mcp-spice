/**
 * Generate tests/fixtures/ from real ngspice 44.2 runs.
 *
 * Run inside the mcp-spice-dev container (Deno must be on PATH):
 *   deno run --allow-all scripts/gen_fixtures.ts
 *
 * Produced files
 * ──────────────
 * tests/fixtures/vdiv.cir           — voltage-divider circuit (no .control)
 * tests/fixtures/vdiv_op.txt        — raw ngspice stdout for that .op run
 * tests/fixtures/rc_tran.cir        — RC low-pass circuit (no .control)
 * tests/fixtures/rc_tran_wrdata.dat — wrdata output from the transient run
 *
 * Physics
 * ───────
 * 1. Voltage divider: R1=1 kΩ, R2=2 kΩ, Vin=3 V DC → V(out)=2.0 V exact.
 * 2. RC low-pass: R=1 kΩ, C=1 µF, Vin=1 V step, τ=1 ms.
 *    V(out) at τ ≈ 0.6321 V (63.21 % of Vin).
 *    V(out) at 5τ ≈ 0.9933 V (99.33 % of Vin).
 *    Simulation: tstep=10 µs, tstop=6 ms (covers > 5τ).
 */

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURES = `${ROOT}tests/fixtures`;

await Deno.mkdir(FIXTURES, { recursive: true });

// ---------------------------------------------------------------------------
// Helper: write a netlist to a temp file, run ngspice -b, return stdout+stderr
// ---------------------------------------------------------------------------

async function runNgspice(netlist: string): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "gen-fixture-" });
  const cirPath = `${tmpDir}/circuit.cir`;
  await Deno.writeTextFile(cirPath, netlist);

  const cmd = new Deno.Command("ngspice", {
    args: ["-b", cirPath],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr } = await cmd.output();
  const log = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  return log;
}

// ---------------------------------------------------------------------------
// 1. Voltage divider — .op
// ---------------------------------------------------------------------------

// Circuit-only (no .control) — this is what the caller supplies to the server
const VDIV_CIRCUIT = `Voltage Divider R1=1k R2=2k Vin=3V
Vin in 0 DC 3
R1 in out 1000
R2 out 0 2000
.op
.end
`;

await Deno.writeTextFile(`${FIXTURES}/vdiv.cir`, VDIV_CIRCUIT);
console.log("Written: tests/fixtures/vdiv.cir");

// Full netlist with server-style .control to capture real output
const VDIV_FULL = `Voltage Divider R1=1k R2=2k Vin=3V
Vin in 0 DC 3
R1 in out 1000
R2 out 0 2000
.op
.control
op
print v(out) v(in) i(Vin)
quit
.endc
.end
`;

const vdivOutput = await runNgspice(VDIV_FULL);
await Deno.writeTextFile(`${FIXTURES}/vdiv_op.txt`, vdivOutput);
console.log("Written: tests/fixtures/vdiv_op.txt");
console.log("--- vdiv_op.txt content ---");
console.log(vdivOutput);

// ---------------------------------------------------------------------------
// 2. RC low-pass — transient with wrdata
// ---------------------------------------------------------------------------

// Circuit-only (no .control)
const RC_CIRCUIT = `RC Low-Pass Filter R=1k C=1uF Vin=1V step
Vin in 0 DC 0 PULSE(0 1 0 1n 1n 10m 20m)
R1 in out 1000
C1 out 0 1e-6
.tran 10u 6m
.end
`;

await Deno.writeTextFile(`${FIXTURES}/rc_tran.cir`, RC_CIRCUIT);
console.log("Written: tests/fixtures/rc_tran.cir");

// Full netlist: wrdata goes to a fixed path under /tmp so we can read it back
// The server normally controls this path; here we hard-code for fixture gen.
const wrdataPath = "/tmp/gen-rc-tran-out.dat";

const RC_FULL = `RC Low-Pass Filter R=1k C=1uF Vin=1V step
Vin in 0 DC 0 PULSE(0 1 0 1n 1n 10m 20m)
R1 in out 1000
C1 out 0 1e-6
.tran 10u 6m
.control
tran 10u 6m
wrdata ${wrdataPath} v(out) v(in)
quit
.endc
.end
`;

const rcOutput = await runNgspice(RC_FULL);
console.log("--- rc_tran ngspice stdout ---");
console.log(rcOutput);

// Read the wrdata file
let wrdataContent: string;
try {
  wrdataContent = await Deno.readTextFile(wrdataPath);
} catch {
  console.error(`ERROR: wrdata file not written at ${wrdataPath}`);
  console.error("ngspice output was:", rcOutput);
  Deno.exit(1);
}

await Deno.writeTextFile(`${FIXTURES}/rc_tran_wrdata.dat`, wrdataContent);
console.log("Written: tests/fixtures/rc_tran_wrdata.dat");

// Show first 6 and last 5 lines of wrdata
const lines = wrdataContent.split("\n").filter((l) => l.trim());
const preview = [
  ...lines.slice(0, 6),
  "...",
  ...lines.slice(-5),
];
console.log("--- rc_tran_wrdata.dat preview ---");
console.log(preview.join("\n"));
console.log(`Total lines (including header): ${lines.length}`);

// Determine header lines (non-numeric start) vs data lines
const dataLines = lines.filter((l) => /^\s*[-+\d]/.test(l));
console.log(`Data lines: ${dataLines.length}`);

if (dataLines.length === 0) {
  console.error("ERROR: no numeric data lines in wrdata output");
  Deno.exit(1);
}

// Determine column count from first data line
const firstDataLine = dataLines[0];
const ncols = firstDataLine.trim().split(/\s+/).length;
console.log(`wrdata columns: ${ncols}, first data line: ${firstDataLine.trim()}`);

// Parse all rows
const rows: number[][] = [];
for (const line of dataLines) {
  const vals = line.trim().split(/\s+/).map(Number);
  if (vals.length === ncols && vals.every(isFinite)) {
    rows.push(vals);
  }
}
console.log(`Parsed rows: ${rows.length}`);

// τ = R*C = 1000 * 1e-6 = 1e-3 s
const TAU = 1e-3;

// Find the row closest to t=τ (wrdata column 0 = time)
const tauRow = rows.reduce((best, row) =>
  Math.abs(row[0] - TAU) < Math.abs(best[0] - TAU) ? row : best
);
console.log(
  `Row at t≈τ=1ms: t=${tauRow[0].toExponential(4)}, v(out)=${
    tauRow[1].toExponential(6)
  }`,
);
console.log(
  `Expected v(out) at τ: ${(1 - Math.exp(-1)).toFixed(6)} V (${
    ((1 - Math.exp(-1)) * 100).toFixed(2)
  }%)`,
);

// Find the row closest to t=5τ
const tau5Row = rows.reduce((best, row) =>
  Math.abs(row[0] - 5 * TAU) < Math.abs(best[0] - 5 * TAU) ? row : best
);
console.log(
  `Row at t≈5τ=5ms: t=${tau5Row[0].toExponential(4)}, v(out)=${
    tau5Row[1].toExponential(6)
  }`,
);
console.log(
  `Expected v(out) at 5τ: ${(1 - Math.exp(-5)).toFixed(6)} V (${
    ((1 - Math.exp(-5)) * 100).toFixed(2)
  }%)`,
);

// Min/max/final for v(out) (wrdata column 1)
const vout = rows.map((r) => r[1]);
const minV = Math.min(...vout);
const maxV = Math.max(...vout);
const finalV = vout[vout.length - 1];
console.log(
  `v(out) min=${minV.toExponential(6)} max=${maxV.toExponential(6)} final=${
    finalV.toExponential(6)
  }`,
);
console.log(`n_points: ${rows.length}`);

await Deno.remove(wrdataPath).catch(() => {});
console.log("\nAll fixtures generated successfully.");
