import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import protobuf from "protobufjs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createChannel } from "nice-grpc";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { TextLoader } from "langchain/document_loaders/fs/text";

const proto = `syntax = "proto3";
package phase6d;
message Message { string text = 1; }
service Echo { rpc Send (Message) returns (Message); }
`;

test("patched protobuf graph loads a trusted schema and round-trips a message", () => {
  const root = protobuf.parse(proto).root;
  const Message = root.lookupType("phase6d.Message");
  const encoded = Message.encode(Message.create({ text: "fixture" })).finish();
  assert.equal(Message.decode(encoded).text, "fixture");
  assert.equal(Message.verify({ text: "fixture" }), null);
});

test("proto-loader, grpc-js, nice-grpc, and Weaviate modules initialize without RPC", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase6d-proto-"));
  try {
    const file = path.join(dir, "fixture.proto");
    fs.writeFileSync(file, proto);
    const definition = protoLoader.loadSync(file);
    const Echo = grpc.loadPackageDefinition(definition).phase6d.Echo;
    const client = new Echo("127.0.0.1:1", grpc.credentials.createInsecure());
    client.close();
    const channel = createChannel("127.0.0.1:1");
    channel.close();
    const weaviate = await import("weaviate-client");
    assert.equal(typeof weaviate.connectToCustom, "function");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("application LangChain loaders initialize and read an isolated local fixture", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase6d-langchain-"));
  try {
    const file = path.join(dir, "fixture.txt");
    fs.writeFileSync(file, "hello\n");
    const documents = await new TextLoader(file).load();
    assert.equal(documents.length, 1);
    assert.match(documents[0].pageContent, /hello/);
    assert.ok(new PDFLoader(path.join(dir, "fixture.pdf")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
