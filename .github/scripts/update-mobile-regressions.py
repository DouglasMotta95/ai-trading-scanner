from pathlib import Path

# Existing regression tests predate the callback-compatible Chrome API gateway.
# Update them to assert the same invariants through the new wrappers rather than
# requiring direct chrome.storage calls that break on callback-only runtimes.

p = Path('test/product-surfaces.test.mjs')
s = p.read_text()
old = "  assert.match(background, /chrome\\.storage\\.session/);"
new = "  assert.match(background, /storageSession(?:Get|Set|Remove)/);"
assert old in s
p.write_text(s.replace(old, new, 1))

p = Path('test/real-flow-gating.test.mjs')
s = p.read_text()
old1 = "  assert.match(background, /chrome\\.storage\\.session\\.get\\(RUNTIME_SESSION_KEY\\)/);"
new1 = "  assert.match(background, /storageSessionGet\\(RUNTIME_SESSION_KEY\\)/);"
old2 = "  assert.match(background, /chrome\\.storage\\.local\\.get\\(COMPLETED_DECISIONS_KEY\\)/);"
new2 = "  assert.match(background, /storageLocalGet\\(COMPLETED_DECISIONS_KEY\\)/);"
assert old1 in s
assert old2 in s
s = s.replace(old1, new1, 1).replace(old2, new2, 1)
p.write_text(s)

p = Path('test/scanner-state-writer-audit.test.mjs')
s = p.read_text()
old = """    if (path.normalize(file) === centralWriter) {
      assert.match(source, /const originalGet = chrome\\.storage\\.local\\.get\\.bind\\(chrome\\.storage\\.local\\)/);
      assert.match(source, /const originalSet = chrome\\.storage\\.local\\.set\\.bind\\(chrome\\.storage\\.local\\)/);
      assert.match(source, /let scannerStateWriteQueue = Promise\\.resolve\\(\\)/);
      assert.match(source, /export async function readScannerState\\(\\)/);
      assert.match(source, /export function updateScannerState\\(mutator\\)/);
      assert.match(source, /await originalSet\\(\\{ scannerState: next \\}\\)/);
      continue;
    }
"""
new = """    if (path.normalize(file) === centralWriter) {
      assert.match(source, /import \\{ storageLocalGet, storageLocalSet \\} from '\\.\\/chrome-compat\\.js'/);
      assert.match(source, /let scannerStateWriteQueue = Promise\\.resolve\\(\\)/);
      assert.match(source, /export async function readScannerState\\(\\)/);
      assert.match(source, /export function updateScannerState\\(mutator\\)/);
      assert.match(source, /storageLocalGet\\('scannerState'\\)/);
      assert.match(source, /await storageLocalSet\\(\\{ scannerState: next \\}\\)/);
      continue;
    }
"""
assert old in s
p.write_text(s.replace(old, new, 1))
