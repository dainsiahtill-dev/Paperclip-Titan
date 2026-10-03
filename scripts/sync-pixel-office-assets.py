"""Publish only browser-approved runtime art; never change NPC library files."""
import hashlib
import json
import shutil
from collections import Counter
from pathlib import Path
from PIL import Image

repo = Path(__file__).resolve().parent.parent
library = (repo / "project-library").resolve()
source = library / "resources/pixel-office/assets/2026-10-01-v1"
approval_path = library / "resources/pixel-office/development-2026-10-01-resumed/approved-npc-runtime.json"
phaser_approval = library / "resources/pixel-office/phaser-2026-10-01/asset-audit/accepted-npc-snapshot.json"
updated_approval = phaser_approval.with_name("approved-update-index.json")
if updated_approval.exists():
    phaser_approval = updated_approval
public = repo / "ui/public/pixel-office"
public.mkdir(parents=True, exist_ok=True)


def publish(path, relative):
    path = path.resolve()
    if source not in path.parents:
        raise ValueError("Sprite outside authoritative library")
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    dest = public / relative
    if public.resolve() not in dest.resolve().parents:
        raise ValueError("Runtime destination outside public asset root")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists() or hashlib.sha256(dest.read_bytes()).hexdigest() != sha:
        shutil.copy2(path, dest)
    return "/pixel-office/" + str(relative) + "?v=" + sha[:12]


sprites = {}
for family in ["architecture", "workstation", "furniture"]:
    manifest = json.loads((source / "environment" / (family + "-manifest-v3.json")).read_text())
    for item in manifest["sprites"]:
        path = source / "environment/slices" / (family + "-v3") / (item["id"] + ".png")
        if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError("Environment sprite differs from reviewed source")
        image = Image.open(path).convert("RGBA")
        alpha = image.getchannel("A")
        solid = alpha.point(lambda a: 255 if a >= 128 else 0).getbbox()
        lower = max(solid[1], round(solid[3] - (solid[3] - solid[1]) * .16))
        ground = alpha.crop((0, lower, image.width, solid[3])).point(lambda a: 255 if a >= 128 else 0).getbbox()
        ground_rect = [ground[0], lower + ground[1], ground[2] - ground[0], ground[3] - ground[1]]
        sprites[item["id"]] = {"src": publish(path, Path("environment") / (item["id"] + ".png")), "size": item["logical_size_px"], "physicalSize": item["physical_size_px"], "blocksMovement": item.get("blocks_movement", False), "ground": ground_rect}

# Review status on an old animation is not approval of a newly recropped file.
# The office owns this explicit registry; the NPC chat remains the source owner.
approval = json.loads(approval_path.read_text())
if approval["status"] != "browser_verified":
    raise ValueError("NPC browser review has not passed")
animations = {}
if phaser_approval.exists():
    snapshot = json.loads(phaser_approval.read_text())
    if not snapshot.get("gate_passed") or snapshot.get("failures"):
        raise ValueError("Phaser asset audit has not passed")
    approved_records = snapshot["frames"]
    approved_keys = {(a["version"], a["character"], a["direction"], a["action"]) for a in snapshot["animation_checks"] if a.get("all_paths_browser_logged", a.get("all_browser_paths_logged")) and a.get("png_hash_and_dimensions_match", a.get("all_current_png_hashes_match")) and not a.get("errors", a.get("browser_errors"))}
    entries = {}
    for a in snapshot["animations"]:
        match = (a["version"], a["character"], a["direction"], a["action"])
        if match not in approved_keys:
            continue
        key = a["character"] + ":" + a["direction"] + ":" + a["action"]
        if key in entries and entries[key]["reviewStatus"] == "accepted" and a["status"] == "accepted_keypose":
            continue
        records = sorted((f for f in approved_records if (f["version"], f["character"], f["direction"], f["action"]) == match), key=lambda f: f["frame"])
        frames = []
        for f in records:
            frames.append({"sourceRelative": f["path"], "sha256": f["sha256"], "size": f["physical_size"], "foot": f.get("effective_source_foot_anchor") or f["source_foot_anchor"], "hip": f.get("effective_source_hip_anchor") or f.get("source_hip_anchor"), "scale": f["render_scale"], "mirror": bool(f.get("mirror_x"))})
        entries[key] = {"character": a["character"], "direction": a["direction"], "action": a["action"], "fps": a["fps"], "playback": a["playback"], "reviewStatus": a["status"], "browserVerified": True, "frames": frames}
    approval["animations"] = entries
def rig_regions(path, foot, mirror):
    image = Image.open(path).convert("RGBA")
    width, height = image.size
    alpha = image.getchannel("A")
    bounds = alpha.point(lambda a: 255 if a >= 128 else 0).getbbox()
    if not bounds:
        raise ValueError("Empty approved NPC")
    x0, y0, x1, y1 = bounds
    body_height = y1 - y0
    split = round(width - foot[0] if mirror else foot[0])
    leg_y = round(y0 + body_height * .74)
    shoe_y = round(y0 + body_height * .9)
    legs = []
    for left, right in [(x0, split), (split, x1)]:
        shoe_bounds = alpha.crop((left, shoe_y, right, y1)).point(lambda a: 255 if a >= 128 else 0).getbbox()
        if not shoe_bounds:
            shoe_bounds = (0, 0, right - left, y1 - shoe_y)
        sx0, sy0, sx1, sy1 = shoe_bounds
        sx0 += left; sx1 += left; sy0 += shoe_y; sy1 += shoe_y
        cut_left, cut_right = max(left, sx0 - 2), min(right, sx1 + 2)
        joint_x = min(cut_right - 1, max(cut_left + 1, split + (-1 if left == x0 else 1) * body_height * .04))
        ankle_y = min(y1 - 1, shoe_y + 2)
        row = [px for px in range(cut_left, cut_right) if alpha.getpixel((px, ankle_y)) >= 128]
        ankle_x = (row[0] + row[-1]) / 2 if row else (sx0 + sx1) / 2
        colors = [image.getpixel((px, py))[:3] for py in range(round(y0 + body_height * .80), round(y0 + body_height * .84)) for px in range(cut_left, cut_right) if image.getpixel((px, py))[3] >= 128]
        inner = [color for color in colors if sum(color) >= 72] or colors
        bucket = Counter(tuple(channel // 16 for channel in color) for color in inner).most_common(1)[0][0] if inner else None
        group = [color for color in inner if tuple(channel // 16 for channel in color) == bucket]
        fill = tuple(round(sum(color[i] for color in group) / len(group)) for i in range(3)) if group else (40, 40, 40)
        outline = min(colors, key=lambda color: sum(color)) if colors else fill
        pack = lambda rgb: rgb[0] * 65536 + rgb[1] * 256 + rgb[2]
        legs.append({"shin": [cut_left, leg_y, cut_right - cut_left, max(1, ankle_y - leg_y + 1)], "shoe": [cut_left, shoe_y, cut_right - cut_left, height - shoe_y], "joint": [joint_x, leg_y], "ankle": [ankle_x, ankle_y], "sole": [(sx0 + sx1) / 2, sy1], "fill": pack(fill), "outline": pack(outline)})
    # Isolate bare hand components instead of moving a whole rectangular side
    # band (which can include ponytails or long braids). Never edit source pixels.
    pixels = image.load()
    color_key = lambda rgb: tuple(channel // 16 for channel in rgb[:3])
    hair = {color_key(pixels[px, py]) for py in range(y0, round(y0 + body_height * .15)) for px in range(x0, x1) if pixels[px, py][3] >= 128}
    hands = []
    center_x = (x0 + x1) / 2
    for side in [0, 1]:
        expected = (x0 + (x1 - x0) * (.18 if side == 0 else .82), y0 + body_height * .72)
        candidates = set()
        for py in range(round(y0 + body_height * .59), round(y0 + body_height * .85)):
            for px in range(x0, x1):
                if (side == 0 and px > center_x - (x1 - x0) * .18) or (side == 1 and px < center_x + (x1 - x0) * .18):
                    continue
                red, green, blue, opacity = pixels[px, py]
                if opacity >= 128 and red > 70 and green > 30 and red > green * .95 and green > blue * .8 and red - blue > 20 and color_key((red, green, blue)) not in hair:
                    candidates.add((px, py))
        components = []
        while candidates:
            component = [candidates.pop()]
            for px, py in component:
                for point in [(px + 1, py), (px - 1, py), (px, py + 1), (px, py - 1)]:
                    if point in candidates: candidates.remove(point); component.append(point)
            if len(component) >= 8:
                bx0 = min(p[0] for p in component); bx1 = max(p[0] for p in component)
                by0 = min(p[1] for p in component); by1 = max(p[1] for p in component)
                distance = ((bx0 + bx1) / 2 - expected[0]) ** 2 + ((by0 + by1) / 2 - expected[1]) ** 2
                components.append((len(component) / (1 + distance / 36), (bx0, by0, bx1, by1)))
        if components:
            bx0, by0, bx1, by1 = max(components)[1]
            hands.append([max(0, bx0 - 2), max(0, by0 - 2), bx1 - bx0 + 5, by1 - by0 + 5])
        else:
            hands.append([round(expected[0] - (x1 - x0) * .08), round(expected[1] - body_height * .05), round((x1 - x0) * .16), round(body_height * .1)])
    return {"bounds": [x0, y0, x1 - x0, body_height], "bodyEnd": round(y0 + body_height * .86), "legs": legs, "hands": hands}


for key, animation in approval["animations"].items():
    if not animation.get("browserVerified") or animation["reviewStatus"] not in ["accepted", "accepted_keypose"]:
        continue
    rendered = []
    for frame in animation["frames"]:
        path = source / "npc" / frame["sourceRelative"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != frame["sha256"]:
            raise ValueError("NPC source changed after browser approval")
        relative = Path("npc") / animation["character"] / Path(frame["sourceRelative"])
        rig = rig_regions(path, frame["foot"], frame.get("mirror", False)) if animation["action"] in ["idle", "typing_seated"] else None
        rendered.append({"src": publish(path, relative), "size": frame["size"], "foot": frame["foot"], "hip": frame.get("hip"), "scale": frame["scale"], "mirror": frame.get("mirror", False), "rig": rig})
    animations[key] = {**animation, "frames": rendered}

result = {"schemaVersion": 1, "sprites": sprites, "animations": animations, "characters": sorted({a["character"] for a in animations.values()}), "provisionalMotionAuthorized": False}
temporary = public / "manifest.new.json"
temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
temporary.replace(public / "manifest.json")
print(json.dumps({"environmentSprites": len(sprites), "characters": len(result["characters"]), "animations": len(animations), "frames": sum(len(a["frames"]) for a in animations.values()), "manifest": str(public / "manifest.json")}))
