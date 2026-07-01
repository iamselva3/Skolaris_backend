"""Tiny pytest-free runner: import every tests/test_*.py and run its test_* functions."""
import importlib
import glob
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
total = passed = failed = 0
for f in sorted(glob.glob("tests/test_*.py")):
    mod = f.replace(os.sep, "/").replace("/", ".")[:-3]
    try:
        m = importlib.import_module(mod)
    except Exception as e:  # noqa: BLE001
        print("IMPORT FAIL", mod, "->", repr(e)[:200])
        failed += 1
        continue
    for n in [x for x in dir(m) if x.startswith("test_") and callable(getattr(m, x))]:
        total += 1
        try:
            getattr(m, n)()
            passed += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print("FAIL", f"{mod}::{n}", "->", repr(e)[:200])
            if os.environ.get("TB"):
                traceback.print_exc()
print(f"--- total={total} passed={passed} failed={failed}")
sys.exit(1 if failed else 0)
