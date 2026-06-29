const protobuf = require("protobufjs");
const path = require("path");

const NEW_LIKE_PROTO_PATH = path.join(
  __dirname,
  "../protoBuf_files/newLike.proto",
);

let NewLikeProto = null;

let newLikeProtoPromise = null;

async function loadNewLikeProto() {
  if (NewLikeProto) {
    return NewLikeProto;
  }

  if (!newLikeProtoPromise) {
    newLikeProtoPromise = protobuf
      .load(NEW_LIKE_PROTO_PATH)
      .then((root) => {
        NewLikeProto = root.lookupType("Users");
        return NewLikeProto;
      });
  }

  return newLikeProtoPromise;
}

// preload
loadNewLikeProto();

module.exports = {
  get NewLikeProto() {
    return NewLikeProto;
  },

  loadNewLikeProto,
};
