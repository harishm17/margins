[Figure]

Figure 2

To generate Pascal’s Triangle, we start by writing a 1. In the row below, row 2, we write two 1’s. In the 3rd row, flank the ends of the rows with 1’s, and add $1 + 1$ to find the middle number, 2. In the $n$th row, flank the ends of the row with 1’s. Each element in the triangle is the sum of the two elements immediately above it.

To see the connection between Pascal’s Triangle and binomial coefficients, let us revisit the expansion of the binomials in general form.

[Figure]

## The Binomial Theorem

The Binomial Theorem is a formula that can be used to expand any binomial.

$$\begin{array}{rcl} (x + y)^{n} & = & \sum_{k = 0}^{n} \binom{n}{k} x^{n - k} y^{k} \\ & = & x^{n} + \binom{n}{1} x^{n - 1} y + \binom{n}{2} x^{n - 2} y^{2} + \ldots + \binom{n}{n - 1} x y^{n - 1} + y^{n} \end{array}$$

## How To

Given a binomial, write it in expanded form.

1. Determine the value of $n$ according to the exponent.
2. Evaluate the $k = 0$ through $k = n$ using the Binomial Theorem formula.
3. Simplify.
