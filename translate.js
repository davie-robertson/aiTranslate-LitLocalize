/**
 * Translates missing content in a folder of XLIFF files.
 *
 * @param {string} directoryPath - The path to the folder containing the XLIFF files.
 * @returns {Promise<void>} - A promise that resolves when the translation process is complete.
 */
import fs from 'fs';
import fsPromises from 'fs/promises';
import { parseStringPromise, Builder } from 'xml2js';
import { stripPrefix } from 'xml2js/lib/processors.js';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY
});

const directoryPath = process.argv[2] || './translations/xliff';
const BATCH_SIZE = 50000; // Maximum allowed by the Batch API

async function createBatchFile(transUnits, targetLanguage) {
	const systemPrompt = {
		custom_id: 'system',
		method: 'POST',
		url: '/v1/chat/completions',
		body: {
			model: 'gpt-4o-mini',
			messages: [
				{
					role: 'system',
					content: `You are a professional translator. Translate the following text accurately and concisely to ${targetLanguage}. Preserve any placeholders or special syntax. Provide ONLY the direct translation of the content, nothing else. Do not translate or include any context information in your response.`
				}
			]
		}
	};

	const batchRequests = [JSON.stringify(systemPrompt)];

	transUnits
		.filter((unit) => unit.source && !unit.target)
		.forEach((unit) => {
			let context = '';
			if (unit.note && unit.note.$ && unit.note.$.from === 'lit-localize') {
				context = `The term/words are in the context of ${unit.note._}\n`;
			}
			batchRequests.push(
				JSON.stringify({
					custom_id: unit.$.id,
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						model: 'gpt-4o-mini',
						messages: [
							{
								role: 'user',
								content: `${context}Translate ONLY the following to ${targetLanguage}. Provide ONLY the translation, nothing else:`
							},
							{ role: 'user', content: unit.source }
						]
					}
				})
			);
		});

	const batchFilePath = path.join(process.cwd(), `batch_${targetLanguage}.jsonl`);
	await fsPromises.writeFile(batchFilePath, batchRequests.join('\n'));
	return batchFilePath;
}

async function submitBatch(batchFilePath, targetLanguage) {
	try {
		const file = await openai.files.create({
			file: fs.createReadStream(batchFilePath),
			purpose: 'batch'
		});

		const batch = await openai.batches.create({
			input_file_id: file.id,
			endpoint: '/v1/chat/completions',
			completion_window: '24h'
		});

		console.log(`Batch submitted for ${targetLanguage}: ${batch.id}`);
		return batch.id;
	} catch (error) {
		console.error(`Error submitting batch for ${targetLanguage}:`, error);
		throw error;
	}
}

async function monitorBatch(batchId, targetLanguage) {
	try {
		let batchStatus;
		do {
			await new Promise((resolve) => setTimeout(resolve, 60000)); // Wait for 1 minute
			batchStatus = await openai.batches.retrieve(batchId);
			console.log(`Batch status for ${targetLanguage}: ${batchStatus.status}`);
		} while (
			batchStatus.status !== 'completed' &&
			batchStatus.status !== 'failed' &&
			batchStatus.status !== 'expired' &&
			batchStatus.status !== 'cancelled'
		);

		if (batchStatus.status === 'completed') {
			const output = await openai.files.content(batchStatus.output_file_id);
			return { status: 'completed', text: await output.text() };
		} else {
			return { status: batchStatus.status, text: null };
		}
	} catch (error) {
		console.error(`Error monitoring batch for ${targetLanguage}:`, error);
		return { status: 'error', text: null };
	}
}

async function processXliffFile(filePath) {
	const data = await fsPromises.readFile(filePath, 'utf8');
	const doc = await parseStringPromise(data, {
		explicitArray: false,
		tagNameProcessors: [stripPrefix]
	});
	const transUnits = doc.xliff.file.body['trans-unit'] || [];
	const targetLanguage = doc.xliff.file.$['target-language'];

	// Check if there are any untranslated units
	const untranslatedUnits = transUnits.filter((unit) => unit.source && !unit.target);
	if (untranslatedUnits.length === 0) {
		console.log(`All units are already translated for ${targetLanguage}. Skipping.`);
		return null;
	}

	const batchFilePath = await createBatchFile(untranslatedUnits, targetLanguage);
	const batchId = await submitBatch(batchFilePath, targetLanguage);

	return { filePath, doc, transUnits, targetLanguage, batchId, batchFilePath };
}

async function updateXmlWithResults(fileInfo, batchResults) {
	const { filePath, doc, transUnits, targetLanguage, batchFilePath } = fileInfo;

	const resultsMap = new Map(
		batchResults
			.split('\n')
			.filter((line) => line.trim() !== '')
			.map((line) => {
				try {
					const result = JSON.parse(line);
					return [result.custom_id, result.response.body.choices[0].message.content.trim()];
				} catch (error) {
					console.error(`Error parsing result line: ${line}`, error);
					return null;
				}
			})
			.filter(Boolean)
	);

	let updatedCount = 0;
	transUnits.forEach((unit) => {
		if (unit.source && !unit.target) {
			unit.target = resultsMap.get(unit.$.id) || '';
			if (unit.target) updatedCount++;
		}
	});

	const builder = new Builder({ explicitArray: false });
	const updatedXml = builder.buildObject(doc);
	await fsPromises.writeFile(filePath, updatedXml);
	console.log(`${targetLanguage} XML file updated successfully! ${updatedCount} translations added.`);

	// Clean up the batch file
	await fsPromises.unlink(batchFilePath);
}

async function translateMissingInFolder(directoryPath) {
	console.log('Translating missing content in folder:', directoryPath);
	const startTime = Date.now();

	try {
		const files = await fsPromises.readdir(directoryPath);
		const xliffFiles = files.filter((file) => path.extname(file) === '.xlf');

		// Process all XLIFF files and submit batches
		const fileInfos = await Promise.all(
			xliffFiles.map(async (file) => {
				console.log('Processing file:', file);
				return processXliffFile(path.join(directoryPath, file));
			})
		);

		// Filter out null fileInfos (files that were already fully translated)
		const filesToProcess = fileInfos.filter((fileInfo) => fileInfo !== null);

		if (filesToProcess.length === 0) {
			console.log('All files are already fully translated. No batches to process.');
			return;
		}

		// Monitor all batches
		const batchResults = await Promise.all(filesToProcess.map((fileInfo) => monitorBatch(fileInfo.batchId, fileInfo.targetLanguage)));

		// Update XML files with results
		for (let i = 0; i < filesToProcess.length; i++) {
			const fileInfo = filesToProcess[i];
			const batchResult = batchResults[i];

			if (batchResult.status === 'completed') {
				await updateXmlWithResults(fileInfo, batchResult.text);
			} else {
				console.log(`Skipping update for ${fileInfo.targetLanguage} due to batch status: ${batchResult.status}`);
			}
		}

		console.log('All files processed successfully!');
	} catch (err) {
		console.error('Error processing files:', err);
	}

	const endTime = Date.now();
	const durationInMilliseconds = endTime - startTime;
	const durationInSeconds = durationInMilliseconds / 1000;
	const minutes = Math.floor(durationInSeconds / 60);
	const seconds = Math.round(durationInSeconds % 60);

	console.log(`Total Duration: ${minutes} minutes, ${seconds} seconds`);
}

translateMissingInFolder(directoryPath).catch(console.error);
