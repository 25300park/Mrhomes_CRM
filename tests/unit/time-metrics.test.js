const { calculatePlanVariance } = require('../../services/time-management/planning')

test('plan variance sums absolute per-standard-category minute differences', () => {
  expect(calculatePlanVariance({
    allocations: [
      { standardCategoryId: 'client', plannedMinutes: 120 },
      { standardCategoryId: 'reports', plannedMinutes: 60 },
      { standardCategoryId: 'client', plannedMinutes: 30 }
    ],
    entries: [
      { standardCategoryId: 'client', durationSeconds: 5400 },
      { standardCategoryId: 'search', durationSeconds: 1800 }
    ]
  })).toBe(150)
})
test('plan variance rounds tracked seconds to minutes only after aggregating each category', () => {
  expect(calculatePlanVariance({
    allocations: [{ standardCategoryId: 'client', plannedMinutes: 1 }],
    entries: [
      { standardCategoryId: 'client', durationSeconds: 31 },
      { standardCategoryId: 'client', durationSeconds: 29 }
    ]
  })).toBe(0)
})
