# prepare_dataset.py
# Place this file in D:\SwachAI\ and run: python prepare_dataset.py
# Requires: pillow, tqdm
# pip install pillow tqdm

import os, random, shutil, math
from PIL import Image, ImageOps, ImageEnhance
from tqdm import tqdm

# CONFIG - adjust if you used different folders
ROOT = r"D:\SwachAI"
RAW = os.path.join(ROOT, "raw_dataset")
OUT = os.path.join(ROOT, "dataset")

# Classes from your screenshot
CLASSES = ["garbage", "pathholes", "drainage leak", "no issue"]

# Splits
SPLIT = {"train": 0.80, "val": 0.10, "test": 0.10}

# Augmentation target for drainage leak training set
DRAINAGE_TARGET = 1200

# Create output dirs
def makedirs(path):
    if not os.path.exists(path):
        os.makedirs(path, exist_ok=True)

for split in SPLIT:
    for c in CLASSES:
        makedirs(os.path.join(OUT, split, c))

makedirs(os.path.join(OUT, "augmented_samples"))

def list_images(folder):
    exts = (".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp")
    if not os.path.isdir(folder):
        return []
    return [os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(exts)]

# Simple augmentation utilities using PIL
def augment_image(img: Image.Image, index:int=0):
    # apply a sequence of low-risk transforms
    # returns a PIL Image
    im = img.copy()

    ops = [
        lambda x: ImageOps.mirror(x) if index % 2 == 0 else x,
        lambda x: ImageOps.flip(x) if index % 3 == 0 else x,
        lambda x: x.rotate( (index % 5 - 2) * 5 , expand=True) if (index % 5)!=0 else x,
        lambda x: ImageEnhance.Color(x).enhance(1.0 + (index % 3) * 0.15),
        lambda x: ImageEnhance.Brightness(x).enhance(1.0 + ((index+1) % 3) * 0.08),
    ]
    for fn in ops:
        try:
            im = fn(im)
        except Exception:
            pass
    # Ensure reasonable size / mode
    if im.mode != "RGB":
        im = im.convert("RGB")
    # optionally center-crop small random area then resize back (keeps shape variety)
    try:
        w,h = im.size
        crop_w = int(w * (0.9 - (index % 3)*0.05))
        crop_h = int(h * (0.9 - (index % 3)*0.05))
        if crop_w < w and crop_h < h:
            left = (w - crop_w)//2
            top = (h - crop_h)//2
            im = im.crop((left, top, left+crop_w, top+crop_h)).resize((w,h))
    except Exception:
        pass
    return im

def safe_save(img, path, quality=90):
    makedirs(os.path.dirname(path))
    try:
        img.save(path, quality=quality)
    except Exception:
        # fallback: convert to RGB and save as JPEG
        img.convert("RGB").save(path, "JPEG", quality=quality)

# Step 1: read raw images for each class
raw_classes = {}
for c in CLASSES:
    folder = os.path.join(RAW, c)
    imgs = list_images(folder)
    raw_classes[c] = imgs
    print(f"Found {len(imgs)} images for class '{c}' in {folder}")

# Basic check
if sum(len(v) for v in raw_classes.values()) == 0:
    print("No images found in raw_dataset. Please check RAW folder path and class names.")
    raise SystemExit(1)

# Step 2: split into train/val/test
for cls, files in raw_classes.items():
    files = files[:]  # copy
    random.shuffle(files)
    n = len(files)
    n_train = int(math.floor(n * SPLIT['train']))
    n_val = int(math.floor(n * SPLIT['val']))
    # remaining to test
    n_test = n - n_train - n_val

    train_files = files[:n_train]
    val_files = files[n_train:n_train+n_val]
    test_files = files[n_train+n_val:]

    def copy_list(file_list, split_name):
        dst_dir = os.path.join(OUT, split_name, cls)
        makedirs(dst_dir)
        for f in file_list:
            try:
                shutil.copy2(f, dst_dir)
            except Exception as e:
                print("Copy failed:", f, e)

    copy_list(train_files, "train")
    copy_list(val_files, "val")
    copy_list(test_files, "test")

    print(f"Class {cls}: train={len(train_files)} val={len(val_files)} test={len(test_files)}")

# Step 3: Augment drainage leak in train until target
drain_cls = "drainage leak"
train_drain_dir = os.path.join(OUT, "train", drain_cls)
backup_dir = os.path.join(OUT, "train", drain_cls + "_backup")
makedirs(backup_dir)
# move originals to backup (so we augment from originals)
orig_files = list_images(train_drain_dir)
if len(orig_files) == 0:
    print("Warning: no training images found for 'drainage leak' after split. Check raw_dataset contents.")
else:
    # backup originals (only if backup is empty)
    if not os.listdir(backup_dir):
        for f in orig_files:
            try:
                shutil.copy2(f, backup_dir)
            except Exception as e:
                print("Backup copy failed:", f, e)
    # ensure we start fresh in train folder (we will repopulate)
    for f in list_images(train_drain_dir):
        try:
            os.remove(f)
        except Exception:
            pass

    # read originals from backup
    origs = list_images(backup_dir)
    if len(origs) == 0:
        print("No originals in backup; skipping augmentation.")
    else:
        # copy originals first (rename to stable filenames)
        cnt = 0
        for f in origs:
            try:
                im = Image.open(f)
                dst = os.path.join(train_drain_dir, f"drain_orig_{cnt:04d}.jpg")
                safe_save(im, dst)
                cnt += 1
            except Exception as e:
                print("Error copying original:", f, e)

        # augment loop until reach target
        cur_files = list_images(train_drain_dir)
        cur_count = len(cur_files)
        sample_idx = 0
        while cur_count < DRAINAGE_TARGET:
            # pick a random original image to transform
            src = random.choice(origs)
            try:
                im = Image.open(src)
                aug = augment_image(im, index=sample_idx)
                dst = os.path.join(train_drain_dir, f"drain_aug_{cur_count:04d}.jpg")
                safe_save(aug, dst)
                # also save a few augmented examples for inspection
                if cur_count < 10:
                    safe_save(aug, os.path.join(OUT, "augmented_samples", f"sample_{cur_count:02d}.jpg"))
                cur_count += 1
                sample_idx += 1
            except Exception as e:
                print("Augment error on", src, e)
                sample_idx += 1
                continue

        print(f"Augmentation complete. Drainage training images now: {cur_count} (target was {DRAINAGE_TARGET})")

# Step 4: print final counts
print("\n=== FINAL COUNTS ===")
for split in ["train","val","test"]:
    for cls in CLASSES:
        path = os.path.join(OUT, split, cls)
        n = len(list_images(path))
        print(f"{split}/{cls}: {n}")
print("====================")

print("\nPrepare complete.")
print(f"Check augmented samples: {os.path.join(OUT, 'augmented_samples')}")
print(f"If counts look wrong, inspect {RAW} and ensure your class folders exist and contain images.")
