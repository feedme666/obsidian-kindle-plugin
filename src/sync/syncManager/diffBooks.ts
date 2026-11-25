import _ from 'lodash';
import moment from 'moment';

import type { Book } from '~/models';

const isEqual = (book1: Book, book2: Book): boolean => {
  return book1.id === book2.id;
};

export const isSameDate = (date1: Date | undefined, date2: Date | undefined): boolean => {
  if (date1 == null || date2 == null) {
    return date1 == null && date2 == null;
  }

  const time1 = date1.getTime();
  const time2 = date2.getTime();

  // Unparseable dates carry NaN, which never compares equal. That used to
  // flag every book as changed on every sync when scraping produced invalid
  // dates. Treat two unknown dates as the same; unknown vs known counts as
  // changed so the stored value gets repaired once.
  if (Number.isNaN(time1) && Number.isNaN(time2)) {
    return true;
  }
  return time1 === time2;
};

const updatedSince = (book: Book, lastSyncDate: Date): boolean => {
  if (book.lastAnnotatedDate != null) {
    return moment(lastSyncDate)
      .startOf('day')
      .subtract(1, 'd')
      .isSameOrBefore(book.lastAnnotatedDate);
  }
  return false;
};

export const diffBooks = (
  remoteBooks: Book[],
  vaultBooks: Book[],
  lastSyncDate: Date
): Book[] => {
  const newBooks = remoteBooks.filter((remote) => !vaultBooks.some((v) => isEqual(v, remote)));

  const diffAnnotatedDates = remoteBooks.filter((remote) =>
    vaultBooks.some(
      (v) => isEqual(v, remote) && !isSameDate(remote.lastAnnotatedDate, v.lastAnnotatedDate)
    )
  );

  const updatedBooks = remoteBooks.filter((remote) =>
    vaultBooks.some((v) => isEqual(v, remote) && updatedSince(remote, lastSyncDate))
  );

  return _.uniqBy([...newBooks, ...diffAnnotatedDates, ...updatedBooks], (book) => book.id);
};
