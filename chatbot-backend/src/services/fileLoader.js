import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv';
import { JSONLoader } from 'langchain/document_loaders/fs/json';
import mammoth from 'mammoth';
import path from 'path';

export async function loadFile(fileBuffer, originalName, mimeType) {
  const ext = path.extname(originalName).toLowerCase();
  let documents = [];

  if (mimeType === 'application/pdf' || ext === '.pdf') {
    const blob = new Blob([fileBuffer], { type: 'application/pdf' });
    const loader = new PDFLoader(blob);
    documents = await loader.load();
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    documents = [{ pageContent: result.value, metadata: { source: originalName, type: 'docx' } }];
  } else if (mimeType === 'text/plain' || ext === '.txt' || ext === '.md') {
    const text = fileBuffer.toString('utf-8');
    documents = [{ pageContent: text, metadata: { source: originalName, type: 'text' } }];
  } else if (mimeType === 'text/csv' || ext === '.csv') {
    const blob = new Blob([fileBuffer], { type: 'text/csv' });
    const loader = new CSVLoader(blob);
    documents = await loader.load();
  } else if (mimeType === 'application/json' || ext === '.json') {
    const text = fileBuffer.toString('utf-8');
    const blob = new Blob([text], { type: 'application/json' });
    const loader = new JSONLoader(blob);
    documents = await loader.load();
  } else {
    throw new Error(`Unsupported file type: ${mimeType || ext}`);
  }

  return documents.map(doc => ({ ...doc, metadata: { ...doc.metadata, originalName, uploadedAt: new Date().toISOString() } }));
}