import bplistParser from "bplist-parser";
import plist from "plist";
import yauzl from "yauzl";

const maximumInfoPlistBytes = 8 * 1024 * 1024;
const primaryAppInfoPath = /^Payload\/[^/]+\.app\/Info\.plist$/u;

function openArchive(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    }, (error, archive) => {
      if (error) reject(error);
      else resolve(archive);
    });
  });
}

async function parseInfoPlist(data) {
  try {
    if (data.subarray(0, 8).toString() === "bplist00") {
      const values = await bplistParser.parseBuffer(data);
      const [value] = values;
      return value;
    }
    return plist.parse(data.toString("utf8"));
  } catch {
    return null;
  }
}

export async function inspectIpa(filePath) {
  const archive = await openArchive(filePath);
  return new Promise((resolve, reject) => {
    let completed = false;

    const fail = (error) => {
      if (completed) return;
      completed = true;
      archive.close();
      reject(error);
    };

    archive.on("error", fail);
    archive.on("end", () => {
      if (!completed) fail(Object.assign(new Error("IPA does not contain a top-level Payload/*.app/Info.plist"), { statusCode: 400 }));
    });
    archive.on("entry", (entry) => {
      if (!primaryAppInfoPath.test(entry.fileName)) {
        archive.readEntry();
        return;
      }
      if (entry.uncompressedSize < 1 || entry.uncompressedSize > maximumInfoPlistBytes) {
        fail(Object.assign(new Error("IPA app metadata exceeds the allowed size"), { statusCode: 400 }));
        return;
      }
      archive.openReadStream(entry, (error, stream) => {
        if (error) {
          fail(Object.assign(new Error("Unable to read IPA app metadata"), { statusCode: 400 }));
          return;
        }
        const chunks = [];
        let size = 0;
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > maximumInfoPlistBytes) {
            stream.destroy(Object.assign(new Error("IPA app metadata exceeds the allowed size"), { statusCode: 400 }));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", () => {
          fail(Object.assign(new Error("Unable to read IPA app metadata"), { statusCode: 400 }));
        });
        stream.on("end", () => {
          if (completed) return;
          parseInfoPlist(Buffer.concat(chunks)).then((info) => {
            const version = info?.CFBundleShortVersionString;
            const build = info?.CFBundleVersion;
            const identifier = info?.CFBundleIdentifier;
            if (![version, build, identifier].every((value) => typeof value === "string" && value.trim())) {
              fail(Object.assign(new Error("IPA is missing a bundle identifier, version, or build in Info.plist"), { statusCode: 400 }));
              return;
            }
            completed = true;
            archive.close();
            resolve({
              bundleIdentifier: identifier.trim(),
              version: version.trim(),
              build: build.trim()
            });
          }).catch(() => {
            fail(Object.assign(new Error("Unable to parse IPA app metadata"), { statusCode: 400 }));
          });
        });
      });
    });
    archive.readEntry();
  });
}
