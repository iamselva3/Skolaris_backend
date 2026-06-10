import { IOcrBatchRepository, OcrBatchListItem } from '../repositories/ocr-batch.repository';
import { ListOcrBatchesUseCase } from './list-ocr-batches.use-case';

describe('ListOcrBatchesUseCase', () => {
  let batches: jest.Mocked<Pick<IOcrBatchRepository, 'listByTenant'>>;
  let useCase: ListOcrBatchesUseCase;

  const item = (id: string): OcrBatchListItem => ({
    batchId: id,
    totalFiles: 2,
    fileCount: 2,
    questionCount: 47,
    completed: 2,
    failed: 0,
    processing: false,
    firstUploadId: `${id}-u0`,
    createdAt: new Date(),
  });

  beforeEach(() => {
    batches = { listByTenant: jest.fn() };
    useCase = new ListOcrBatchesUseCase(batches as unknown as IOcrBatchRepository);
  });

  it('delegates to the repository with tenant + paging and returns its result', async () => {
    const data = [item('b-1'), item('b-2')];
    batches.listByTenant.mockResolvedValue({ data, total: 2 });

    const r = await useCase.execute({ tenantId: 't-1', limit: 25, offset: 0 });

    expect(batches.listByTenant).toHaveBeenCalledWith('t-1', 25, 0);
    expect(r.total).toBe(2);
    expect(r.data).toHaveLength(2);
    expect(r.data[0].questionCount).toBe(47);
    expect(r.data[0].firstUploadId).toBe('b-1-u0');
  });
});
