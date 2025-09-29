import { FirestoreController, FirestoreMock } from '../..';

describe('Structual database tests', () => {
  let env!: FirestoreMock;
  beforeEach(() => {
    env = new FirestoreMock();
  });

  it('Create from structural database JSON compare', async () => {
    const ctrl = env.createDatabase();
    ctrl.database.setDocument('col1/doc1', { value: 'col1/doc1' });
    ctrl.database.setDocument('col1/doc1/col1a/doc2', {
      value: 'col1/doc1/col1a/doc2',
    });
    const map1 = ctrl.database.toStructuralDatabase();
    const json1 = JSON.stringify(map1);
    ctrl.database.reset();
    ctrl.database.fromStructuralDatabase(map1);
    const map2 = ctrl.database.toStructuralDatabase();
    const json2 = JSON.stringify(map2);
    expect(json1).toEqual(json2);
  });

  it('Create from structural database', async () => {
    const ctrl = env.createDatabase();
    ctrl.database.fromStructuralDatabase({
      A: {
        A1: {
          data: { value: 'A/A1' },
        },
      },
      B: {
        B1: {
          collections: {
            B1A: {
              B1A1: {
                collections: {
                  B1A1A: {
                    B1A1A1: {
                      collections: {},
                      data: {},
                    },
                  },
                },
                data: { value: 'B/B1/B1A/B1A1' },
              },
            },
          },
        },
      },
      C: {
        C1: {
          collections: {
            C1A: {
              C1A1: {
                collections: {
                  C1A1A: {
                    C1A1A1: {
                      collections: {
                        C1A1A1A: {
                          C1A1A1A1: {
                            data: {},
                          },
                        },
                      },
                      data: {},
                    },
                  },
                },
                data: {},
              },
            },
          },
        },
        C2: {
          data: {},
        },
      },
    });
    expectDocData('A/A1', ctrl);
    expectDocData('B/B1/B1A/B1A1', ctrl);
    expectDocData('B/B1/B1A/B1A1/B1A1A/B1A1A1', ctrl, false);
    expectDocData('C/C1/C1A/C1A1', ctrl, false);
    expectDocData('C/C1/C1A/C1A1/C1A1A/C1A1A1', ctrl, false);
    expectDocData('C/C1/C1A/C1A1/C1A1A/C1A1A1/C1A1A1A/C1A1A1A1', ctrl, false);
    expectDocData('C/C2', ctrl, false);
    const exported = ctrl.database.toStructuralDatabase();

    expect(exported).toEqual({
      A: {
        A1: {
          data: { value: 'A/A1' },
        },
      },
      B: {
        B1: {
          collections: {
            B1A: {
              B1A1: {
                data: { value: 'B/B1/B1A/B1A1' },
                collections: {
                  B1A1A: {
                    B1A1A1: {
                      data: {}, // persisted empty doc
                    },
                  },
                },
              },
            },
          },
        },
      },
      C: {
        C1: {
          collections: {
            C1A: {
              C1A1: {
                data: {}, // persisted empty doc
                collections: {
                  C1A1A: {
                    C1A1A1: {
                      data: {}, // persisted empty doc
                      collections: {
                        C1A1A1A: {
                          C1A1A1A1: {
                            data: {}, // persisted empty doc
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        C2: {
          data: {}, // persisted empty doc
        },
      },
    });
  });
});

function expectDocData(
  path: string,
  ctrl: FirestoreController,
  expectExists = true
): void {
  // expect a document path
  expect(path.split('/').length % 2).toBe(0);
  const actual = ctrl.database.getDocument(path);
  expect(actual.exists).toBe(true);
  if (expectExists) {
    expect(actual.data).toEqual({ value: path });
  } else {
    expect(actual.data).toEqual({});
  }
}
