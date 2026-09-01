# check_dataset.py
import os, random
base = r"D:\SwachAI\dataset"   # <- change if your dataset path differs

for split in ("train","val","test"):
    spath = os.path.join(base, split)
    print(f"\n=== {split.upper()} ===")
    if not os.path.exists(spath):
        print("  MISSING:", spath)
        continue
    total = 0
    for cls in sorted(os.listdir(spath)):
        cdir = os.path.join(spath, cls)
        if not os.path.isdir(cdir): continue
        files = [f for f in os.listdir(cdir) if f.lower().endswith((".jpg",".jpeg",".png"))]
        print(f"  {cls}: {len(files)}")
        total += len(files)
        # show up to 3 sample names
        samples = random.sample(files, min(3, len(files)))
        for s in samples:
            print("    >", s)
    print("  total images:", total)
