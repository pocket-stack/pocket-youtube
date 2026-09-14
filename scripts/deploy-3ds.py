"""Install a native launcher through ftpd, preserving pairing and previous bytes."""
import argparse
import datetime
import ftplib
import hashlib
import io
import json
import pathlib
import secrets

parser = argparse.ArgumentParser()
parser.add_argument("--host", required=True)
parser.add_argument("--ftp-port", type=int, default=5000)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
binary = root / "dist/3ds/pocket-youtube.3dsx"
data = binary.read_bytes()
if b"pocketjs-captures" in data:
    raise RuntimeError("Rebuild without --capture before installing for manual acceptance")
manifest = json.loads((root / "pocket.json").read_text())
slot = hashlib.sha256(manifest["id"].encode()).hexdigest()[:16]
if ("offload/" + slot + ".key").encode() not in data:
    raise RuntimeError("Launcher does not contain this application's pairing slot")
state = root / ".pocket"
state.mkdir(exist_ok=True)
key_path = state / "offload.key"
ftp = ftplib.FTP()
ftp.connect(args.host, args.ftp_port, timeout=20)
ftp.login()

def read(path):
    out = io.BytesIO()
    try:
        ftp.retrbinary("RETR " + path, out.write)
    except (ftplib.error_perm, ftplib.error_temp) as error:
        if str(error).startswith("550") or str(error) == "450 No such file or directory":
            return None
        raise
    return out.getvalue()

def write(path, content):
    ftp.storbinary("STOR " + path, io.BytesIO(content), blocksize=65536)
    if read(path) != content:
        raise RuntimeError("Readback mismatch: " + path)

try:
    for path in ["/3ds", "/pocketjs", "/pocketjs/offload", "/pocketjs/runtime", "/pocketjs/runtime/native-backups"]:
        try:
            ftp.mkd(path)
        except ftplib.error_perm as error:
            if not str(error).startswith("550"):
                raise
    remote_key = "/pocketjs/offload/" + slot + ".key"
    key = read(remote_key)
    if key is None:
        key = key_path.read_bytes() if key_path.exists() else secrets.token_hex(32).encode()
        if len(key.strip()) != 64 or any(c not in b"0123456789abcdef" for c in key.strip()):
            raise RuntimeError("Invalid pairing key")
        write(remote_key, key)
    elif len(key.strip()) != 64 or any(c not in b"0123456789abcdef" for c in key.strip()):
        raise RuntimeError("Existing device pairing is invalid; it was preserved")
    key_path.touch(mode=0o600, exist_ok=True)
    key_path.chmod(0o600)
    key_path.write_bytes(key)
    remote = "/3ds/pocket-youtube.3dsx"
    previous = read(remote)
    backup = None
    if previous is not None and previous != data:
        backup = "/pocketjs/runtime/native-backups/pocket-youtube-" + hashlib.sha256(previous).hexdigest()[:16] + ".3dsx"
        write(backup, previous)
    write(remote, data)
    dsp_firmware = read("/3ds/dspfirm.cdc")
    dsp_present = bool(dsp_firmware)
    if not dsp_present:
        print("DSP firmware is absent on SD. Before playback, open Rosalina with L + D-pad Down + SELECT, then Miscellaneous options > Dump DSP firmware.")
    receipt = {
        "date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "host": args.host, "port": args.ftp_port, "remote": remote, "backup": backup,
        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
        "pairingReadback": True, "readback": "byte-identical", "physicalPlaybackAcceptance": "pending",
        "dspFirmwareOnSd": dsp_present,
    }
    (state / "last-deploy-3ds.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
finally:
    ftp.close()
