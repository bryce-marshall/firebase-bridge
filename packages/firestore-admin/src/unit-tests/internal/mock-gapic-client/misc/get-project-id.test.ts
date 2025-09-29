import {
  MOCK_PROJECT_ID,
  mockGapicTestContext,
  MockGapicTestContext,
} from '../test-utils';

describe('MockGapicClient getProjectId tests', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext();
  });

  it('resolves projectId', async () => {
    const projectId = await Mock.client.getProjectId();
    expect(projectId).toEqual(MOCK_PROJECT_ID);
  });
});
