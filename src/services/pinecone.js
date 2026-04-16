import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeStore } from '@langchain/pinecone';
import { OpenAIEmbeddings } from '@langchain/openai';

let pineconeClient = null;
let embeddings = null;

export const initPinecone = async () => {
  if (!pineconeClient) pineconeClient = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  if (!embeddings) embeddings = new OpenAIEmbeddings({ model: 'text-embedding-3-small' });
  return { client: pineconeClient, embeddings };
};

export const getVectorStore = async (namespace) => {
  const { client, embeddings } = await initPinecone();
  const index = client.Index(process.env.PINECONE_INDEX);
  return await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex: index,
    namespace: namespace || 'default',
  });
};

export const getRetriever = async (namespace, k = 4) => {
  const store = await getVectorStore(namespace);
  return store.asRetriever({ k });
};